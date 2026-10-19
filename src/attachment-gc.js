/**
 * 附件自动回收（GC）—— 专治"每轮裁决存一张截图，而 DSH 不给删除接口"。
 *
 * 实测：`~/.dsh/attachments/v1/objects` **1783 个 / 1.73 GB**，按天分布完全对上插件运行的日子
 * （OpenCode 那边同类问题是 639MB 的 session DB，主人 C: 一度只剩 0 字节）。
 *
 * 为什么不能"按内容哈希认领"：`saveImage` 会重新编码，我本地那份截图的 sha256 与仓库里的对象
 * **对不上**（实测三个文件全部未命中）→ 只能**记账**：`saveImage` 返回什么就记什么。
 *
 * 安全边界（宁可少删，不可误删）：
 *   - **只删记账过的东西**（自己创建的），绝不按"大小/时间"去扫别人的图；
 *   - 保留最新 `keepCount` 条 + `keepMinutes` 分钟内的（正在用的那几张）；
 *   - 总占用超过 `maxMB` 才继续从最旧的删（这是"不撑爆 C 盘"的硬上限）；
 *   - 认不出可删路径的记录只标记不动手（并把返回结构打进日志，便于适配）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 从 `saveImage` 的返回里算出可删的本地绝对路径。
 *
 * **实测的返回结构**：`{ attachmentId: 'sha256:<64hex>', mediaType, bytes, width, height }`
 * —— **没有 path 字段** ✗。而仓库是内容寻址的：文件就在
 * `$DSH_HOME/attachments/v1/objects/<hex 前两位>/<hex>`（实测四个文件路径与字节数完全对上）。
 * 所以这里按 id 反推路径；同时兼容将来可能出现的 path/url 字段。
 *
 * @param {object} record 记账条目
 * @param {string} [storeRoot] 附件对象根目录（`…/attachments/v1/objects`）
 */
export function resolveAttachmentPath(record, storeRoot = '') {
  if (!record || typeof record !== 'object') return '';
  for (const key of ['path', 'file', 'localPath', 'filePath', 'diskPath']) {
    const value = record[key];
    if (typeof value === 'string' && isAbsolute(value) && existsSync(value)) return value;
  }
  const url = record.url;
  if (typeof url === 'string' && url.startsWith('file://')) {
    try {
      const p = fileURLToPath(url);
      if (isAbsolute(p) && existsSync(p)) return p;
    } catch {
      /* 不合法的 file:// 就跳过 */
    }
  }
  // 关键：attachmentId = sha256:<hex> → objects/<前2位>/<hex>
  const rawId = typeof record.attachmentId === 'string' ? record.attachmentId : '';
  const hex = rawId.startsWith('sha256:') ? rawId.slice('sha256:'.length) : /^[0-9a-f]{64}$/i.test(rawId) ? rawId : '';
  if (hex && storeRoot) {
    const sharded = join(storeRoot, hex.slice(0, 2), hex);
    if (existsSync(sharded)) return sharded;
    const flat = join(storeRoot, hex);
    if (existsSync(flat)) return flat;
  }
  return '';
}

/** 记账用的稳定键（优先 id，其次路径，再不行用时间+大小） */
export function recordKey(record) {
  if (!record || typeof record !== 'object') return '';
  for (const key of ['id', 'attachmentId', 'hash', 'name']) {
    if (typeof record[key] === 'string' && record[key]) return `${key}:${record[key]}`;
  }
  const p = resolveAttachmentPath(record);
  if (p) return `path:${p}`;
  return `at:${record.at ?? ''}:${record.bytes ?? ''}`;
}

/**
 * 纯决策：该留哪些、该删哪些（不碰文件系统，便于测试）。
 * @param {{records:Array<{at:number,bytes?:number}>, now:number, keepCount:number, keepMinutes:number, maxMB:number}} input
 * @returns {{keep:Array, drop:Array, reason:string}}
 */
export function planSweep({ records = [], now = Date.now(), keepCount = 60, keepMinutes = 30, maxMB = 600 } = {}) {
  const sorted = [...records].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)); // 新的在前
  const fresh = keepMinutes > 0 ? keepMinutes * 60_000 : 0;
  const keep = [];
  const drop = [];
  let keptBytes = 0;
  sorted.forEach((rec, index) => {
    const isNewest = index < keepCount;
    const isFresh = fresh > 0 && now - (rec.at ?? 0) < fresh;
    if (isNewest || isFresh) {
      keep.push(rec);
      keptBytes += rec.bytes ?? 0;
    } else {
      drop.push(rec);
    }
  });
  // 硬上限：保留集合自身超过 maxMB 时，从最旧的保留项继续往下删
  const limit = Math.max(0, maxMB) * 1024 * 1024;
  if (limit > 0 && keptBytes > limit) {
    const stillKeep = [];
    let acc = 0;
    for (const rec of keep) {
      if (acc + (rec.bytes ?? 0) <= limit) {
        stillKeep.push(rec);
        acc += rec.bytes ?? 0;
      } else {
        drop.push(rec);
      }
    }
    keep.length = 0;
    keep.push(...stillKeep);
    return { keep, drop, reason: 'over-size-cap' };
  }
  return { keep, drop, reason: drop.length ? 'over-count' : 'nothing-to-do' };
}

/**
 * @param {{file:string, log?:(m:string)=>void, keepCount?:number, keepMinutes?:number, maxMB?:number}} options
 */
export function createAttachmentGc(options) {
  const log = options.log ?? (() => {});
  const file = options.file;
  /** 附件对象根目录（用于按 attachmentId 反推路径） */
  const storeRoot = String(options.storeRoot ?? '');
  /**
   * 单次扫描最多删多少个。
   *
   * 为什么要有：万一哪天记账逻辑出错（或者解析出的路径不对），一次也不该删掉成百上千个 ——
   * 这是"**永远不要一次删太多**"的硬保险。真出现积压，多扫几轮即可。
   */
  const maxPerSweep = Math.max(1, Number(options.maxPerSweep ?? 30));
  const keepCount = Math.max(1, Number(options.keepCount ?? 60));
  const keepMinutes = Math.max(1, Number(options.keepMinutes ?? 30));
  const maxMB = Math.max(64, Number(options.maxMB ?? 600));
  let records = [];
  let lastSweepAt = 0;
  let dropped = 0;
  let freedBytes = 0;
  let unknownShape = 0;

  function load() {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      records = Array.isArray(raw?.records) ? raw.records : [];
    } catch {
      records = [];
    }
  }

  /** 串行写：先写 .tmp 再改名（避免半个 JSON）；调用点只有计时器与该模块自身，天然串行 */
  function save() {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ records: records.slice(-4000) }, null, 0), 'utf8');
      renameSync(tmp, file);
    } catch (error) {
      log('附件账本写入失败：' + (error?.message ?? error));
    }
  }

  load();

  return {
    /** 记一笔（`saveImage` 的返回原样传进来即可） */
    record(attachment) {
      if (!attachment || typeof attachment !== 'object') return false;
      const key = recordKey(attachment);
      if (!key) return false;
      if (records.some((r) => recordKey(r) === key)) return false;
      let bytes = Number(attachment.bytes ?? attachment.size ?? 0);
      const p = resolveAttachmentPath(attachment, storeRoot);
      if (!bytes && p) {
        try {
          bytes = statSync(p).size;
        } catch {
          bytes = 0;
        }
      }
      records.push({ at: Date.now(), bytes, ...attachment });
      // 第一次记的时候把返回结构打进日志：万一字段名和预期不同，从日志就能看出来该适配哪个键
      if (records.length === 1) log('附件记账字段：' + JSON.stringify(attachment).slice(0, 160));
      save();
      return true;
    },

    /** 扫一次：删掉超出保留策略的**自己创建的**附件 */
    sweep(now = Date.now()) {
      if (!records.length) return { removed: 0, freedBytes: 0 };
      const { keep, drop, reason } = planSweep({ records, now, keepCount, keepMinutes, maxMB });
      if (!drop.length) {
        lastSweepAt = now;
        return { removed: 0, freedBytes: 0, reason };
      }
      let removed = 0;
      let freed = 0;
      const survivors = [];
      for (const rec of drop) {
        if (removed >= maxPerSweep) {
          // 到上限就停手，剩下的下轮再说（"永不一次删太多"）
          survivors.push(rec);
          continue;
        }
        const p = resolveAttachmentPath(rec, storeRoot);
        if (!p) {
          // 认不出路径：留着记录（别丢账），只统计一次，避免日志刷屏
          unknownShape += 1;
          survivors.push(rec);
          continue;
        }
        try {
          const size = rec.bytes ?? statSync(p).size;
          unlinkSync(p);
          removed += 1;
          freed += size;
        } catch {
          unknownShape += 1;
          survivors.push(rec);
        }
      }
      records = [...keep, ...survivors].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      dropped += removed;
      freedBytes += freed;
      lastSweepAt = now;
      save();
      if (removed) {
        log(`附件自动回收：删 ${removed} 个，释放 ${(freed / 1024 / 1024).toFixed(1)} MB（保留 ${records.length} 个）`);
      }
      return { removed, freedBytes: freed, reason };
    },

    stats() {
      const bytes = records.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
      return {
        tracked: records.length,
        trackedBytes: bytes,
        dropped,
        freedBytes,
        unknownShape,
        keepCount,
        keepMinutes,
        maxMB,
        maxPerSweep,
        storeRoot,
        lastSweepAt: lastSweepAt || null,
        indexFile: file,
      };
    },
  };
}

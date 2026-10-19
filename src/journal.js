/**
 * 历史日志（追加式 JSONL）—— 让历史**不再依赖"谁正在运行"**。
 *
 * 背景（用户报的问题）：历史页原来只合并三处**活的**来源：
 *   memory（插件记忆，落盘 ✓）、board（内存时间线 ✗）、副本 /gpw/log（副本一关就拉不到 ✗）。
 * 于是"另一个仓库那只鱼（7350）关掉之后，它说过的话就从历史里消失了"。
 *
 * 做法：插件每轮轮询后，把自己**看到过的**时间线整条追加进 `history.jsonl`。
 *   - 只追加，不改写：进程重启、对家退出、副本重启都不影响已有记录 ✓
 *   - 按 `at|text` 去重（进程内 Set，启动时用文件尾部播种），重复追加不产生重复行 ✓
 *   - 超过 MAX_BYTES 就轮转一份 `.1`（保留一代），避免无限长
 *
 * 为什么不用 SQLite：这里是"几百到几万行、只追加、按时间看"的形态，JSONL 更简单、
 * 也能直接用记事本看/用 grep 搜，出问题不用装任何东西。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8MB ≈ 十几万条，够用很久

export function createJournal(options) {
  const file = options.file;
  const log = options.log ?? (() => {});
  const maxBytes = Number(options.maxBytes ?? DEFAULT_MAX_BYTES);
  /** 见过的键（at|text），用于跨轮去重；启动时从文件尾部播种 */
  const seen = new Set();
  let appended = 0;

  const keyOf = (e) => `${e.at}|${e.text}`;

  /** 读文件（不存在就空）。返回 [{at,kind,who,text,image?,source}] */
  function parse(text) {
    const out = [];
    for (const line of text.split(String.fromCharCode(10))) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const e = JSON.parse(trimmed);
        if (Number.isFinite(e?.at) && typeof e.text === 'string' && e.text) out.push(e);
      } catch {
        /* 半行/坏行跳过（正在写时可能读到半行） */
      }
    }
    return out;
  }

  /**
   * 启动播种：把文件里最近若干条的键装进 seen，避免重启后又把同一批当"新的"追加一遍。
   * 只播尾部（默认 5000 行）：更早的行即使重复，去重也交给读取端，启动不必扫全文件。
   */
  function seed(limit = 5000) {
    if (!existsSync(file)) return 0;
    try {
      const lines = readFileSync(file, 'utf8').split(String.fromCharCode(10));
      const tail = lines.slice(-limit);
      for (const line of tail) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const e = JSON.parse(trimmed);
          if (Number.isFinite(e?.at) && typeof e.text === 'string') seen.add(keyOf(e));
        } catch {
          /* 忽略坏行 */
        }
      }
      return seen.size;
    } catch (error) {
      log('历史日志播种失败（不影响追加）：' + (error?.message ?? error));
      return 0;
    }
  }

  function rotateIfNeeded() {
    try {
      if (!existsSync(file)) return;
      if (statSync(file).size < maxBytes) return;
      renameSync(file, file + '.1');
      log('历史日志已轮转：' + file + ' → .1');
    } catch {
      /* 轮转失败就不轮转，继续追加 */
    }
  }

  return {
    file,
    /** 启动时调一次：把已有记录的键装进去重集合（否则重启后会把同一批再写一遍） */
    seed,
    /**
     * 追加一批（自动去重、自动轮转）。返回真正写进去的条数。
     * @param {Array<{at:number,kind?:string,who?:string,text:string,image?:string,source?:string}>} entries
     */
    append(entries = []) {
      const fresh = [];
      for (const e of entries) {
        if (!e || !Number.isFinite(e.at) || typeof e.text !== 'string' || !e.text.trim()) continue;
        const key = keyOf(e);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push({
          at: e.at,
          kind: e.kind ?? 'peer',
          who: e.who ?? '',
          text: e.text.trim(),
          ...(e.image ? { image: e.image } : {}),
        });
      }
      if (!fresh.length) return 0;
      try {
        mkdirSync(dirname(file), { recursive: true });
        rotateIfNeeded();
        appendFileSync(file, fresh.map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
        appended += fresh.length;
      } catch (error) {
        log('历史日志写入失败：' + (error?.message ?? error));
        return 0;
      }
      return fresh.length;
    },
    /** 读全部（上限可给）；返回未排序的原始条目 */
    load(limit = 0) {
      if (!existsSync(file)) return [];
      try {
        const entries = parse(readFileSync(file, 'utf8'));
        return limit > 0 ? entries.slice(-limit) : entries;
      } catch (error) {
        log('历史日志读取失败：' + (error?.message ?? error));
        return [];
      }
    },
    stats() {
      let bytes = 0;
      try {
        bytes = existsSync(file) ? statSync(file).size : 0;
      } catch {
        /* 忽略 */
      }
      return { file, bytes, seen: seen.size, appended, rotated: existsSync(file + '.1') };
    },
  };
}

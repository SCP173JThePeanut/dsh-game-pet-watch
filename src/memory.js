/**
 * 记忆：短期（最近若干轮）+ 长期（模型自己压出来的要点 + 主人手写的备注）。
 *
 * 只在两处被写：
 *   1. 本插件问模型得到台词时
 *   2. 主人的回话进来时（/game-pet-watch/ask）
 * 另外每一轮都会去 dsh-pet 的 /state 读一次宠物气泡文本：碎碎念、/chat 对话、
 * 别人投喂的话都从那条叶子走，于是也进了同一本账。同一条文本按计数器去重。
 *
 * 落盘：$DSH_HOME/game-pet-watch/memory.json（短期）+ profile patch 里的 config 由 config-store 管。
 * 结构只加不减地兼容：读到旧版本、缺字段、坏 JSON 都不会让插件停摆。
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const EMPTY = () => ({ v: 1, entries: [], longTerm: { at: null, text: '' }, notes: [], petCursor: 0 });
/**
 * 每个会话保留的来往条数上限。
 *
 * 说明：原来写死 400 且**所有上下文共用一份记忆** ✗ —— 群聊一多就互相挤占。
 * 现在每个会话各一份记忆文件（见 index.js 的 memoryFor），所以这个上限是"每个会话各 800" ✓。
 */
const MAX_ENTRIES = 800;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export class MemoryStore {
  /**
   * @param {string} file memory.json 的绝对路径
   * @param {(message: string) => void} [log]
   */
  constructor(file, log) {
    this.file = file;
    this.log = log ?? (() => {});
    this.data = EMPTY();
    this.loaded = false;
    this.writeChain = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this.data;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        v: 1,
        entries: safeArray(parsed?.entries).filter((e) => e && typeof e.text === 'string'),
        longTerm: {
          at: typeof parsed?.longTerm?.at === 'number' ? parsed.longTerm.at : null,
          text: typeof parsed?.longTerm?.text === 'string' ? parsed.longTerm.text : '',
          // 模型自己追加过几条（重启后别丢，设置页/状态里要看）
          selfAdded: typeof parsed?.longTerm?.selfAdded === 'number' ? parsed.longTerm.selfAdded : 0,
        },
        notes: safeArray(parsed?.notes).filter((n) => n && typeof n.text === 'string'),
        petCursor: typeof parsed?.petCursor === 'number' ? parsed.petCursor : 0,
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // 坏文件：备份后重来，绝不让记忆问题把插件拖死
        try {
          await rename(this.file, `${this.file}.bak-${Date.now()}`);
          this.log('记忆文件损坏，已备份并重来：' + this.file);
        } catch {
          /* 备份失败也不阻塞 */
        }
      }
      this.data = EMPTY();
    }
    this.loaded = true;
    return this.data;
  }

  /** 串行落盘：写操作排队，避免并发覆盖 */
  async persist() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, snapshot, 'utf8');
    });
    return this.writeChain;
  }

  /**
   * 记一条。
   * @param {{role:'pet'|'me'|'system', kind:string, text:string, meta?:object}} entry
   */
  async add(entry) {
    await this.load();
    const text = String(entry.text ?? '').trim();
    if (!text) return undefined;
    const item = {
      id: `${Date.now().toString(36)}-${(this.data.entries.length + 1).toString(36)}`,
      at: Date.now(),
      role: entry.role,
      kind: entry.kind,
      text,
      ...(entry.meta ? { meta: entry.meta } : {}),
    };
    this.data.entries.push(item);
    if (this.data.entries.length > MAX_ENTRIES) this.data.entries.splice(0, this.data.entries.length - MAX_ENTRIES);
    await this.persist();
    return item;
  }

  /** 最近 n 条（新→旧排列还是旧→新？这里返回旧→新，方便直接渲染） */
  recent(n = 40) {
    const entries = this.data.entries;
    return entries.slice(Math.max(0, entries.length - n));
  }

  /**
   * 组装进提示词的上下文块：长期要点 + 主人备注 + 最近若干条对话。
   *
   * `includeSystem === false` 时**跳过 `role:'system'` 的条目**（游戏事件原文那类）。
   * 对应插件配置 `memoryIncludeSystem`（默认 true = 老行为）。
   */
  contextBlock(recentLimit = 12, { includeSystem = true } = {}) {
    const lines = [];
    const longTerm = this.data.longTerm.text.trim();
    if (longTerm) lines.push('【长期记忆】', longTerm, '');
    const notes = this.data.notes.map((n) => n.text.trim()).filter(Boolean);
    if (notes.length) lines.push('【主人交代过的】', ...notes.map((n) => '- ' + n), '');
    const recent = this.recent(recentLimit);
    if (recent.length) {
      lines.push('【刚才的来往】');
      for (const item of recent) {
        // 系统条目（游戏事件原文）由配置决定要不要带进上下文
        if (!includeSystem && item.role === 'system') continue;
        const who = item.role === 'pet' ? '你' : item.role === 'me' ? '主人' : '系统';
        lines.push(`- (${who}) ${item.text}`);
      }
    }
    return lines.join('\n').trim();
  }

  /** 需要重压长期记忆了吗：距离上次压缩后新增的来往条数 */
  turnsSinceCompaction(threshold) {
    const lastAt = this.data.longTerm.at ?? 0;
    const since = this.data.entries.filter((e) => e.at > lastAt && e.kind !== 'compact' && e.role !== 'system');
    return since.length >= threshold ? since : undefined;
  }

  /**
   * **模型自己记一条长期记忆**（`remember` 字段）。
   *
   * @param {string} text 一句话（会压成单行、去掉前导 - ）
   * @param {{limit?:number}} [options] limit = 字符上限（默认 2400）
   * @returns {Promise<{added:boolean, reason?:string, overflow?:boolean, lines?:number}>}
   */
  async appendLongTerm(text, options = {}) {
    const limit = Math.max(200, Number(options.limit) || 2400);
    let line = String(text ?? '').replace(/\s+/g, ' ').trim();
    line = line.replace(/^[-*·]\s*/, '').trim();
    if (!line) return { added: false, reason: 'empty' };
    if (line.length > 300) line = line.slice(0, 300).trim();
    await this.load();
    const current = String(this.data.longTerm.text ?? '').trim();
    /**
     * 重复就不加：**子串判断**足够挡住"同一件事又说一遍"。
     * 只是别用完全相等 —— 模型复述时常常多几个字。
     */
    const body = current.replace(/^[-*·]\s*/gm, '');
    if (body.includes(line)) return { added: false, reason: 'duplicate' };
    const next = current ? current + '\n- ' + line : '- ' + line;
    const overflow = next.length > limit;
    const prior = Number(this.data.longTerm?.selfAdded) || 0;
    this.data.longTerm = { text: next, at: this.data.longTerm.at ?? Date.now(), selfAdded: prior + 1 };
    await this.persist();
    return { added: true, overflow, lines: next.split('\n').length };
  }

  async setLongTerm(text, at) {
    await this.load();
    /**
     * 压缩会整段重写长期记忆 —— 但"模型自己追加过几条"这个计数要带过去，
     * 否则每次压缩后设置页/状态里的计数都归零，看起来像从未记过。
     */
    this.data.longTerm = {
      text: String(text ?? '').trim(),
      at: at ?? Date.now(),
      selfAdded: Number(this.data.longTerm?.selfAdded) || 0,
    };
    await this.persist();
  }

  async addNote(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return undefined;
    await this.load();
    const note = { id: `n-${Date.now().toString(36)}`, at: Date.now(), text: trimmed };
    this.data.notes.push(note);
    if (this.data.notes.length > 50) this.data.notes.splice(0, this.data.notes.length - 50);
    await this.persist();
    return note;
  }

  async removeNote(id) {
    await this.load();
    const before = this.data.notes.length;
    this.data.notes = this.data.notes.filter((n) => n.id !== id);
    if (this.data.notes.length !== before) await this.persist();
    return this.data.notes.length !== before;
  }

  async clear(kind) {
    await this.load();
    if (kind === 'all') this.data = EMPTY();
    else if (kind === 'short') this.data.entries = [];
    else if (kind === 'long') this.data.longTerm = { at: null, text: '' };
    else if (kind === 'notes') this.data.notes = [];
    await this.persist();
  }

  /** dsh-pet 气泡文本去重游标：同一 counter 不重复记账 */
  petCursor() {
    return this.data.petCursor;
  }

  async setPetCursor(counter) {
    await this.load();
    if (this.data.petCursor === counter) return false;
    this.data.petCursor = counter;
    await this.persist();
    return true;
  }

  snapshot() {
    return {
      longTerm: { ...this.data.longTerm },
      notes: this.data.notes.map((n) => ({ ...n })),
      entries: this.recent(60),
      total: this.data.entries.length,
    };
  }
}

/**
 * @param {string} dataDir 数据目录（插件里由 `resolveDataDir()` 统一决定：
 *   默认 `$DSH_HOME/game-pet-watch`，配置 `dataDir` 可整体搬到别的盘）
 */
export function memoryFilePath(dataDir) {
  return join(dataDir, 'memory.json');
}

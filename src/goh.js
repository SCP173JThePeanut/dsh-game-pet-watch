/**
 * GoH（Gate of Hell）对局事件源 —— 读 `goh-event-to-text` 输出的 JSONL 增量。
 *
 * 为什么用"读 JSONL 增量"而不是把采集器当子进程（它自己也提供 `--stdout` 直连）：
 *   - 进程解耦：采集器挂了/没起，插件不受影响；插件重启也不用管采集器；
 *   - 采集器本来就会把事件**追加**写到同一个文件，天然适合按偏移读；
 *   - 不用管 stdout 管道断开（那正是"宿主没了就自杀"这类坑的来源）。
 *
 * 读法：记住上次读到的**字节偏移**（持久化到磁盘），下次只读新增部分。
 * 偏移持久化的意义：插件重启（DSH 重启）后不会把整局历史当"新事件"重放，
 * 否则一开机就对着几百条旧事件疯狂反应。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 默认"值得当场开口"的事件类型（可在配置里覆盖） */
export const DEFAULT_IMPORTANT_KINDS = [
  'evt/flag_captured',
  'evt/flag_lost',
  'wave_spawn/trigger',
  'lua_print/-',
];

/** 事件类型的显示键，与采集器的 kind/subkind 对齐 */
const kindKey = (ev) => `${ev.kind}/${ev.subkind || '-'}`;

export class GohWatcher {
  /**
   * @param {{file:string, stateFile:string, log?:(m:string)=>void}} options
   */
  constructor(options) {
    this.file = options.file;
    this.stateFile = options.stateFile;
    this.log = options.log ?? (() => {});
    /** 已读到的字节偏移 */
    this.offset = 0;
    /** 离线/首次使用：从文件末尾开始，避免把历史当新事件重放 */
    this.ready = false;
    /** 最近事件（给提示词当上下文用），最多 60 条 */
    this.recent = [];
    /** 累计读到的事件数 */
    this.total = 0;
    /** 最近一次读到事件的时间 */
    this.lastEventAt = null;
    this.lastError = '';
    /** 击杀突发检测：最近击杀的时间戳（毫秒） */
    this.killTimes = [];
    /**
     * 当前"局"（采集器给每条事件都带 `session` 序号）。
     *
     * 为什么要它：`recent` 最多留 60 条、**跨局混杂** —— 上一局的夺旗/连杀会一直躺在
     * 提示词里，于是新的一局刚开，宠物还在评论上一局的事（用户报的"不区分上一局"）。
     * 换局时清空 `recent`，并在提示词里明确说"这是新的一局"。
     */
    this.session = null;
    /** 换局时间（用于提示词里说明"这局刚开"） */
    this.sessionStartedAt = null;
    /**
     * 自上次"被消费"以来读到多少条新事件。
     * `promptBlockFresh()` 读走并清零 —— 模型据此区分"有新进展"和"只是在念旧账"。
     */
    this.newCount = 0;
    this.loadState();
  }

  loadState() {
    try {
      if (existsSync(this.stateFile)) {
        const raw = JSON.parse(readFileSync(this.stateFile, 'utf8'));
        if (Number.isFinite(raw?.offset)) this.offset = Number(raw.offset);
        if (Number.isFinite(raw?.total)) this.total = Number(raw.total);
      }
    } catch (error) {
      this.log('GoH 状态文件读失败：' + (error?.message ?? error));
    }
  }

  saveState() {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify({ offset: this.offset, total: this.total }), 'utf8');
    } catch {
      /* 状态写不了不影响主流程 */
    }
  }

  /**
   * 读一次新增内容。
   * @returns {Array<object>} 本次新读到的事件（已解析）
   */
  poll() {
    if (!this.file) return [];
    let size;
    try {
      size = statSync(this.file).size;
    } catch {
      // 文件还没出现（或采集器没在跑）：不是错误，静默
      return [];
    }

    /**
     * 文件被截断/轮转（采集器重启换了文件、或用户清空了它）：**跳到末尾继续，绝不重读历史**。
     *
     * 为什么不是"偏移归零重新读"：那会把整局历史当成"新事件"。实测两局日志 963 条里
     * 有几十条是夺旗/增援这类"重要事件" —— 重读会让插件对着历史疯狂反应（一串莫名其妙的宠物发言）。
     * 漏掉几条旧事件远好过刷一屏历史反应；清空事件文件因此变成安全操作。
     */
    if (size < this.offset) {
      this.log(`事件文件被截断/轮转（新大小 ${size} < 已读 ${this.offset}）：跳到末尾继续，不重读历史`);
      this.offset = size;
      this.ready = true;
      this.saveState();
      return [];
    }

    // 首次使用该文件：从**末尾**开始，不把历史当新事件
    if (!this.ready) {
      this.offset = size;
      this.ready = true;
      this.saveState();
      return [];
    }

    if (size === this.offset) return [];

    let text = '';
    try {
      const fd = openSync(this.file, 'r');
      const length = size - this.offset;
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, this.offset);
      closeSync(fd);
      text = buf.toString('utf8');
      this.offset = size;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.log('GoH 事件读取失败：' + this.lastError);
      return [];
    }

    const events = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // 半行（正在写）或脏行：跳过即可，下一轮会读到完整行
      }
    }

    if (events.length) {
      this.total += events.length;
      this.lastEventAt = Date.now();
      this.newCount += events.length;

      /**
       * 换局检测：采集器给每条事件都带 `session`。序号变了就是新的一局 ——
       * 清空 `recent`（绝不把上一局的事留在上下文里），并记一条便于排障。
       */
      const newest = [...events].reverse().find((e) => Number.isFinite(e?.session))?.session;
      if (Number.isFinite(newest) && newest !== this.session) {
        const isFirst = this.session === null;
        this.session = newest;
        this.sessionStartedAt = Date.now();
        this.recent = [];
        if (!isFirst) this.log(`检测到新的一局（session ${newest}）→ 已清空上一局的事件上下文`);
      }

      this.recent.push(...events);
      if (this.recent.length > 60) this.recent = this.recent.slice(-60);
      this.saveState();
    }
    return events;
  }

  /**
   * 从新事件里挑出"值得当场反应"的：配置里列的类型，或"短时间内连续击杀"。
   * @param {Array<object>} events
   * @param {{importantKinds?:string[], killBurstCount?:number, killBurstSec?:number}} options
   */
  pickImportant(events, options = {}) {
    const kinds = new Set(options.importantKinds ?? DEFAULT_IMPORTANT_KINDS);
    const burstCount = Math.max(2, Number(options.killBurstCount ?? 3));
    const burstMs = Math.max(1, Number(options.killBurstSec ?? 8)) * 1000;
    const now = Date.now();
    const out = [];

    for (const ev of events) {
      const key = kindKey(ev);
      if (kinds.has(key) || kinds.has(`${ev.kind}/*`) || kinds.has(ev.kind)) {
        out.push(ev);
        continue;
      }
      if (ev.kind === 'evt' && (ev.subkind === 'kill' || ev.subkind === 'kill_env')) {
        this.killTimes.push(now);
        this.killTimes = this.killTimes.filter((t) => now - t <= burstMs);
        // 只在"刚好达到阈值"时产出一条，避免持续交火时每帧都报
        if (this.killTimes.length === burstCount) {
          const recentKills = this.recent.filter((e) => e.kind === 'evt' && String(e.subkind || '').startsWith('kill')).slice(-burstCount);
          out.push({
            kind: 'synthetic',
            subkind: 'kill_burst',
            text_zh: `短时间里连续 ${burstCount} 次击杀：` + recentKills.map((e) => e.text_zh || e.text || '').join('；'),
            ts_wall_ms: now,
          });
        }
      }
    }
    return out;
  }

  /** 当前这一局的事件（换局时 recent 已清空，所以通常就是它本身） */
  currentSessionEvents() {
    if (!Number.isFinite(this.session)) return this.recent;
    return this.recent.filter((e) => !Number.isFinite(e?.session) || e.session === this.session);
  }

  /** 给提示词用的"游戏正在发生"上下文块（**只含当前这一局**）。只读，不消费新鲜度。 */
  promptBlock(maxLines = 10) {
    const lines = this.currentSessionEvents()
      .slice(-Math.max(1, maxLines))
      .map((ev) => `- ${ev.offset || ''} ${ev.text_zh || ev.text || ev.raw || ''}`.trim());
    if (!lines.length) return '';
    return ['【游戏里最近发生的事（来自游戏日志，按时间先后）】', ...lines].join('\n');
  }

  /**
   * 观察循环专用的上下文块：**会消费"新鲜度"**（读一次就清零）。
   *
   * 用户报的"没信息的时候会一直反应之前的事情"，根因就在这里：
   * 以前每次都把最近 N 条无脑倒给模型，而这些条目可能几十分钟没变过 ——
   * 模型看到"最近发生的事"里有夺旗，就又把夺旗评论一遍。
   *
   * 现在的行为：
   *   - 有**新事件**：正常给（只给当前这一局）
   *   - **没有新事件**：明确写"自上次以来没有新事件"，并把下面的标成"旧事、别当新闻再讲"
   *   - 刚换局：额外说明"这是新的一局"
   *
   * 只有观察循环该调它（别在 `/state` 这类只读接口里调，否则会把新鲜度吃掉）。
   */
  promptBlockFresh(maxLines = 10) {
    const fresh = this.newCount;
    this.newCount = 0;
    const lines = this.currentSessionEvents()
      .slice(-Math.max(1, maxLines))
      .map((ev) => `- ${ev.offset || ''} ${ev.text_zh || ev.text || ev.raw || ''}`.trim());
    const head = [];
    if (this.sessionStartedAt && Date.now() - this.sessionStartedAt < 120000) {
      head.push('【这是新的一局（刚开），下面的事件都属于这一局】');
    }
    if (!lines.length) return head.join('\n');
    if (fresh > 0) {
      return [...head, '【游戏里最近发生的事（来自游戏日志，按时间先后）】', ...lines].join('\n');
    }
    return [
      ...head,
      '【自上次以来游戏里**没有新事件**。下面这些是更早发生的，只作背景，不要当成新闻再讲一遍，也不要点评同一件事。】',
      ...lines,
    ].join('\n');
  }

  status() {
    return {
      file: this.file,
      ready: this.ready,
      offset: this.offset,
      total: this.total,
      recent: this.recent.length,
      session: this.session,
      newSinceLastLook: this.newCount,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError || '',
      last: this.recent.length ? this.recent[this.recent.length - 1].text_zh ?? null : null,
    };
  }
}

/**
 * 事件源选择的取值与显示名。空字符串 = 不看游戏（默认）。
 */
/**
 * 事件源选项：**不绑定任何一款游戏**。
 * alue: 'file' 表示"读用户自己填的那个事件文件"（设置里的「事件文件」路径），
 * 'goh' 只是历史别名（老配置里存的是它），两者等价。
 */
export const GAME_SOURCE_OPTIONS = [
  { value: '', label: '关闭（不看游戏事件）' },
  { value: 'file', label: '本地事件文件（路径在设置里填）' },
];

/** 任意"开着"的来源值：'file' 与历史别名 'goh' 都算开 */
export const isGameSourceOn = (value) => {
  const s = String(value ?? '').trim();
  return s === 'file' || s === 'goh';
};

/**
 * @param {string} dataDir 数据目录（见 memory.js 的 memoryFilePath）
 */
export function gohStateFile(dataDir) {
  return join(dataDir, 'goh-state.json');
}

/**
 * 游戏机制数据库（GoH 机制库）—— 两级：
 *
 *   ① **速查（quick）**：一直塞在系统提示词里。它是**静态文本**，所以放进系统提示词只会
 *      增加一次缓存写入，之后每轮都命中缓存（实测缓存命中 99.7%），几乎不要钱。
 *      内容只放"模型猜不到"的机制（资源/占旗/模式/经济），不放兵种知识。
 *   ② **完整库（full）**：37KB、435 行，不可能常驻。做成**工具按需查询**：
 *      模型不确定某机制时发起 tool-call，插件在完整库里检索相关章节，把命中内容回给模型。
 *
 * 为什么不把完整库全塞进去：约 1.2 万 token，每轮都带既贵又稀释注意力；而实际只有少数回合
 * 需要细节。按需检索既省钱又更准（返回的是"相关章节"，不是整本书）。
 */
import { readFileSync, statSync } from 'node:fs';

/** 检索结果的默认字符上限（防止一次返回把上下文塞爆） */
const DEFAULT_MAX_CHARS = 6000;

/** 当前支持的数据库来源。空字符串 = 不启用。 */
/** 机制库选项：**不绑定任何一款游戏**，读用户在设置里填的 markdown 路径 */
export const DATABASE_SOURCE_OPTIONS = [
  { value: '', label: '关闭（不带机制库）' },
  { value: 'file', label: '本地机制库文件（路径在设置里填）' },
];

/** 任意"开着"的来源值：'file' 与历史别名 'goh' 都算开 */
export const isDatabaseSourceOn = (value) => {
  const s = String(value ?? '').trim();
  return s === 'file' || s === 'goh';
};

/**
 * 把 Markdown 按 `##` / `###` 标题切成章节。
 * 返回 `[{id, title, level, body}]`，body 含该标题到下一个同级/更高级标题之间的全部内容。
 */
export function splitSections(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const match = /^(#{2,3})\s+(.*\S)\s*$/.exec(line);
    if (match) {
      if (current) sections.push(current);
      current = { id: match[2].trim(), title: match[2].trim(), level: match[1].length, body: '' };
      continue;
    }
    if (current) current.body += line + '\n';
  }
  if (current) sections.push(current);
  return sections;
}

/** 查询词切成检索项：ASCII 词（≥2 字符）+ 中文 2-gram（中文没有空格，2-gram 是最省事的可靠切法） */
export function queryTerms(query) {
  const text = String(query ?? '');
  const terms = new Set();
  for (const word of text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []) terms.add(word);
  const cjk = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjk) {
    if (run.length === 1) terms.add(run);
    for (let i = 0; i + 2 <= run.length; i += 1) terms.add(run.slice(i, i + 2));
  }
  return [...terms];
}

export class MechanicsStore {
  /**
   * @param {{quickFile:string, fullFile:string, maxChars?:number, log?:(m:string)=>void}} options
   */
  constructor(options) {
    this.quickFile = options.quickFile;
    this.fullFile = options.fullFile;
    this.maxChars = Math.max(500, Number(options.maxChars ?? DEFAULT_MAX_CHARS));
    this.log = options.log ?? (() => {});
    this.quick = '';
    this.full = '';
    this.sections = [];
    this.quickMtime = 0;
    this.fullMtime = 0;
    this.lastError = '';
    this.lookups = 0;
    this.lastQuery = '';
    this.lastHits = [];
    this.load();
  }

  /** 读文件（按 mtime 缓存：用户在编辑 md，不该每轮都读盘） */
  load() {
    const read = (file) => {
      const info = statSync(file);
      return { text: readFileSync(file, 'utf8'), mtime: info.mtimeMs };
    };
    try {
      const quick = read(this.quickFile);
      this.quick = quick.text;
      this.quickMtime = quick.mtime;
    } catch (error) {
      this.lastError = `读不到速查文件：${error?.message ?? error}`;
      this.log(this.lastError);
    }
    try {
      const full = read(this.fullFile);
      this.full = full.text;
      this.fullMtime = full.mtime;
      this.sections = splitSections(full.text);
    } catch (error) {
      this.lastError = `读不到完整库：${error?.message ?? error}`;
      this.log(this.lastError);
    }
    return this;
  }

  /** 文件被改过就重读（用户刚更新了 md 的场景） */
  refreshIfChanged() {
    try {
      const quickChanged = statSync(this.quickFile).mtimeMs !== this.quickMtime;
      const fullChanged = statSync(this.fullFile).mtimeMs !== this.fullMtime;
      if (quickChanged || fullChanged) {
        this.load();
        this.log('机制库文件已更新，已重新载入');
      }
    } catch {
      /* 文件暂时不可读就保持旧内容 */
    }
    return this;
  }

  /**
   * 检索相关章节。
   * @param {string} query 模型给的关键词/问题
   * @param {{limit?:number, maxChars?:number}} [options]
   * @returns {{text:string, hits:Array<{title:string, score:number}>}}
   */
  search(query, options = {}) {
    this.lookups += 1;
    this.lastQuery = String(query ?? '');
    if (!this.sections.length) this.load();

    const terms = queryTerms(query);
    const limit = Math.max(1, Number(options.limit ?? 3));
    const budget = Math.max(500, Number(options.maxChars ?? this.maxChars));

    const scored = this.sections.map((section) => {
      const title = section.title.toLowerCase();
      const body = section.body.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 6;
        // 正文命中：计数但设上限，避免长章节靠"某个字出现得多"霸榜
        let hits = 0;
        let at = body.indexOf(term);
        while (at !== -1 && hits < 12) {
          hits += 1;
          at = body.indexOf(term, at + term.length);
        }
        score += hits;
      }
      return { section, score };
    });

    const picked = scored
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    this.lastHits = picked.map((item) => ({ title: item.section.title, score: item.score }));

    if (!picked.length) {
      return {
        text: `（机制库里没有检索到「${query}」相关的内容。可以换个关键词再查一次；若确实没有，就不要编造，直接说你不确定。）`,
        hits: [],
      };
    }

    const parts = [];
    let used = 0;
    for (const item of picked) {
      const block = `### ${item.section.title}\n${item.section.body.trim()}`;
      if (used + block.length > budget && parts.length) break;
      parts.push(block.length > budget ? block.slice(0, budget) : block);
      used += block.length;
    }
    return {
      text: `以下是机制库里与「${query}」最相关的 ${parts.length} 节（来自完整机制库）：\n\n${parts.join('\n\n')}`,
      hits: this.lastHits,
    };
  }

  /** 给系统提示词用的速查块 */
  quickBlock() {
    if (!this.quick.trim()) return '';
    return [
      '【游戏机制速查（这些是模型容易猜错的机制，回答时以此为准）】',
      this.quick.trim(),
      '【如果你需要某个机制的确切数值或细节，调用 goh_mechanics 工具查询完整机制库，不要凭印象编造。】',
    ].join('\n');
  }

  status() {
    return {
      quickFile: this.quickFile,
      fullFile: this.fullFile,
      quickChars: this.quick.length,
      fullChars: this.full.length,
      sections: this.sections.length,
      lookups: this.lookups,
      lastQuery: this.lastQuery,
      lastHits: this.lastHits,
      lastError: this.lastError || '',
    };
  }
}

/**
 * 给模型看的工具定义（JSON Schema）。
 * description 里明确写"什么时候用、不要编造"，这是工具能不能被正确调用的关键。
 */
export const MECHANICS_TOOL = {
  name: 'goh_mechanics',
  description:
    '查询本作完整机制库（规则、数值、mod 改动、日志词表等，内容以主人的文件为准）。' +
    '当你对某个机制的数值或规则不确定、或速查里没有写清楚时，先调用它拿到确切内容再回答；' +
    '不要凭印象编造机制细节。参数 query 传一个简短的关键词（如"占旗时间"、"MP 收入"、"AI 预算"、"DP"）。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要查询的机制关键词或短问题，例如"夺旗需要多久"' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

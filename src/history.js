/**
 * 历史记录的合并（只读）：把三处来源合成一条**按时间降序**的时间线。
 *
 * 为什么要在插件里合并，而不是让网页去拉三个接口：
 *   ① 副本在另一个端口（7341/7350），浏览器跨源 fetch 会被拦；服务端拉没有这个限制；
 *   ② 三处来源互相重叠（同一句话可能同时在记忆、鱼板、副本日志里），**必须服务端去重**，
 *      否则页面要写一遍同样的规则，两份规则迟早不一致；
 *   ③ 网页只拿一个结果，分页/筛选都好做。
 *
 * 来源与语义：
 *   - `memory`：插件记忆（主人说的话 + 宠物说过的话 + 系统注记）——**这是最完整的一份**
 *   - `board`：鱼板时间线（含**别的宠物**说过的话；这是唯一能看到对家的来源）
 *   - `fork`：副本自己的说话记录（带配图名；含面板/胶囊直接触发的那种话）
 *   - `peerfile`：**对家落盘的文件**（`$DSH_HOME` 下兄弟副本目录里的 `state.json`，取其 `log` 数组）——
 *     对家进程关着时实时接口拉不到，但文件还在，所以"关着的对家"也还能看到
 *   - `journal`：**落盘的历史日志**（`history.jsonl`）—— 唯一"不依赖谁正在运行"的来源：
 *     对家退出、副本重启之后，它说过的话仍然在历史里（其余三处都是"活的"来源）
 *
 * 去重键 = `at|text`（不含说话者）：踩过的坑是两份副本可能共用同一个 userRoot，
 * 同一条记录会同时出现在多个来源里且 `at` 完全相同 —— 那是**同一条物理记录**。
 */

/** 说话者分类：me = 本插件这只宠物、master = 主人、peer = 别的宠物、sys = 系统 */
const KIND_LABEL = { me: '我', master: '主人', peer: '别的宠物', sys: '系统' };

/** 记忆里的 role → 分类 */
export function kindOfRole(role) {
  const r = String(role ?? '').toLowerCase();
  if (r === 'me' || r === 'user' || r === 'master') return 'master';
  if (r === 'pet' || r === 'assistant' || r === 'auto' || r === 'reply') return 'me';
  if (r === 'system' || r === 'note') return 'sys';
  return 'peer';
}

/** 鱼板里的 who → 分类（who 是「我」/「主人」/别的宠物的名字） */
export function kindOfWho(who) {
  const w = String(who ?? '').trim();
  if (!w) return 'peer';
  if (w === '我') return 'me';
  if (w === '主人') return 'master';
  if (w === '系统' || w === 'system') return 'sys';
  return 'peer';
}

const KINDS = new Set(['me', 'master', 'peer', 'sys']);

function normalize(entry, source) {
  if (!entry || !Number.isFinite(entry.at) || typeof entry.text !== 'string' || !entry.text.trim()) return null;
  /**
   * 分类优先级：**条目自带的 kind** > 按来源推断。
   * 历史日志（journal）里存的就是规范化后的 kind，直接信它；
   * 记忆（memory）看 role、鱼板（board）看 who、副本（fork）默认算自己说的。
   */
  const kind = KINDS.has(entry.kind)
    ? entry.kind
    : source === 'memory'
      ? kindOfRole(entry.role)
      : source === 'board'
        ? kindOfWho(entry.who)
        : 'me';
  const who =
    typeof entry.who === 'string' && entry.who.trim()
      ? entry.who.trim()
      : KIND_LABEL[kind];
  return {
    at: entry.at,
    kind,
    who,
    text: entry.text.trim(),
    // `to` = 主人这句话说给谁听（'*' 全体 / 具体名字）。历史页据此显示「主人 → X」
    ...(typeof entry.to === 'string' && entry.to ? { to: entry.to } : {}),
    ...(typeof entry.image === 'string' && entry.image ? { image: entry.image } : {}),
    source,
  };
}

/**
 * 合并三处来源。
 * @param {{memory?:object[], board?:object[], fork?:object[]}} sources
 * @param {{limit?:number}} [options] limit 截取**最新的** N 条（0/未给 = 全量）
 * @returns {Array<{at:number,kind:string,who:string,text:string,image?:string,source:string}>} 时间**降序**
 */
export function mergeHistory(sources = {}, options = {}) {
  const collected = [];
  for (const entry of sources.memory ?? []) collected.push(normalize(entry, 'memory'));
  for (const entry of sources.board ?? []) collected.push(normalize(entry, 'board'));
  for (const entry of sources.fork ?? []) collected.push(normalize(entry, 'fork'));
  for (const entry of sources.journal ?? []) collected.push(normalize(entry, 'journal'));
  for (const entry of sources.peerfile ?? []) collected.push(normalize(entry, 'peerfile'));

  const items = collected.filter(Boolean);
  // 先按时间**升序**走，便于"同文本 + 时间接近"合并（输出前再翻成降序）
  items.sort((a, b) => a.at - b.at);

  /**
   * 去重：**同文本 + 时间接近（时间窗）算同一条**。
   *
   * 为什么不能只用 `at|text`：同一句话会同时出现在两处，而两处的 `at` 差几毫秒 ——
   * 记忆里的时间是"插件决定说这句"的时刻，副本日志里是"它把这句话显示出来"的时刻。
   * 实测差 1–2ms，于是 `at|text` 认不出是同一条、历史页里就出现成对的重复。
   *
   * 合并时顺手取长补短：任一份带配图就用配图；分类优先非 sys（那只是注记）。
   * 时间窗 3 秒：足够覆盖这种几毫秒的漂移，又不会把"隔一会儿又说一遍"的真重复吃掉。
   */
  /**
   * 窗口：**90 秒**（2026-10-19 修）。
   *
   * 3 秒只够覆盖"同一瞬间两处各写一次"；但记忆那一份是跟着 `syncPetSpeech` 的轮询同步的，
   * 最多能晚一整拍（intervalSec=60）。实测截图上成对出现的两条相差 20~90 秒，
   * 窗口太小时历史页每条话都显示两遍。
   */
  const WINDOW_MS = 90_000;
  /** 同来源内的"快速重复"才按 3 秒算（同一来源两条相同文本 = 真的说了两遍） */
  const SAME_SOURCE_WINDOW_MS = 3000;
  /**
   * 去重键：**剥掉「（主人对…说）」前缀**再比。
   *
   * 主人的同一条广播会同时进两处，而两处文本不同：
   *   记忆里：`（主人对全体说）你们俩都听着`（前缀是给模型看"这句对谁说"的）
   *   板子/日志：`你们俩都听着` + `to:'*'` 字段
   * 不剥前缀就认不出是同一条 → 历史页里每条主人消息显示两遍（实测到了）。
   * 显示仍然用原文，只有比较用剥过的。
   */
  const dedupeKey = (text) => String(text).replace(/^（主人对[^）]*说）/, '');
  const lastByText = new Map();
  const merged = [];
  for (const item of items) {
    const key = dedupeKey(item.text);
    const prev = lastByText.get(key);
    /**
     * **跨来源才算重复**：记忆与鱼板/日志是同一句话的两份记录；
     * 而同一来源里 90 秒内又说一遍同样的句子，是真的说了两遍，别合并掉。
     */
    const sameSource = prev && prev.source === item.source;
    const window = sameSource ? SAME_SOURCE_WINDOW_MS : WINDOW_MS;
    if (prev && item.at - prev.at <= window) {
      // 同一条：补齐缺的字段，不新增条目
      if (!prev.image && item.image) prev.image = item.image;
      if (!prev.to && item.to) prev.to = item.to; // 带目标的那份补上（记忆版没有 to）
      if (prev.kind === 'sys' && item.kind !== 'sys') prev.kind = item.kind;
      continue;
    }
    lastByText.set(key, item);
    merged.push(item);
  }

  /**
   * 显示前把冗余前缀剥掉：带 `to` 的条目，历史页会另外显示「主人 → 全体」，
   * 文本里再留一句「（主人对全体说）」就是重复（页面上看着很啰嗦）。
   * 只有确实带 `to` 的才剥，剥的是同一个前缀（不会误伤正常文本）。
   */
  for (const item of merged) {
    if (item.to) item.text = dedupeKey(item.text);
  }

  // 降序：最新的在最上面（阅读习惯）
  merged.sort((a, b) => b.at - a.at);
  const limit = Number(options.limit ?? 0);
  return limit > 0 ? merged.slice(0, limit) : merged;
}

/** 每种来源各贡献了多少条（排障用：某个来源为 0 就说明它没拉到） */
export function sourceCounts(entries) {
  const out = { memory: 0, board: 0, fork: 0, journal: 0, peerfile: 0 };
  for (const entry of entries) out[entry.source] = (out[entry.source] ?? 0) + 1;
  return out;
}

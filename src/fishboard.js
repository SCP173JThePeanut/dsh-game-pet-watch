/**
 * 鱼板网络（Fish Board v1）：让同一台机器上**多只桌宠**互相看见"最近说了什么"。
 *
 * 背景：这台机器上现在同时跑着两只宠物（本仓库这只 7341、另一个仓库抄的那只 7342），
 * 用户希望它们能看到彼此的话，从而能互相接话。协议见仓库根的 `FISH-BOARD.md`。
 *
 * 设计要点（都是踩过坑换来的）：
 *   1. **"我"是谁必须由配置/默认值确定**，绝不靠"谁先应答"判断。
 *      那次事故：插件扫 7341/7342/7343 找副本，结果认领了另一只鱼，
 *      自己的鱼死了也永远不重启（"DSH 鱼起不来"）。所以这里：自己的 origin 是入参，
 *      发现对等体时**显式排除自己的端口**。
 *   2. 时间戳同步用**游标**（每个来源记上次见过的最大 at），只取更新的，天然幂等、可重复轮询。
 *   3. 对等体可以随时不在（对方在改代码/重启），探测与拉取全部容错，失败只跳过。
 *   4. 只保留最近 N 条：这是"最近说了什么"，不是聊天记录归档（归档在各自副本的 fishlog.jsonl）。
 */
// 默认探测范围：留出余量到 7360（另一份副本在 7350 —— 它挪一次就出界了）
const DEFAULT_PORTS = [7341, 7342, 7343, 7344, 7345, 7346, 7347, 7348, 7349, 7350,
  7351, 7352, 7353, 7354, 7355, 7356, 7357, 7358, 7359, 7360];
const MAX_ENTRIES = 80;

/** 从一组候选中挑出对等体：排除自己、按端口排序（顺序稳定，提示词才不会每轮乱跳） */
export function pickPeers(brands, selfOrigin) {
  const selfPort = Number(new URL(selfOrigin).port || 80);
  const seen = new Set();
  const out = [];
  for (const brand of brands) {
    if (!brand || !brand.ok) continue;
    /**
     * **协议判定：只做前缀判断**（`fish-board/*` 都认 ✓，字段缺失也认 ✓）。
     *
     * 为什么不能严格比 `=== 'fish-board/1'` 或 `'fish-board/2'` ✗：
     *   · 同一台机器上**两套 fork 各自升级** ✓，不可能同时切版本 ✓
     *   · v1 → v2 是**纯加法**（多了 scope/fishId ✓ 老副本不带也完全能用 ✓）
     *   → 严格比对只会造成"对方莫名消失" ✗（那才是真的断网 ✓）
     * 只把**根本不是鱼板协议**的响应排除掉 ✓。
     */
    const proto = String(brand.protocol ?? '').trim();
    if (proto && !proto.startsWith('fish-board/')) continue;
    const port = Number(brand.port);
    if (!Number.isFinite(port) || port === selfPort || seen.has(port)) continue;
    seen.add(port);
    /** v2 的身份字段（老副本没有 ✓ 就留空 ✓，不影响使用） */
    out.push({
      origin: `http://127.0.0.1:${port}`,
      port,
      name: brand.name || `#${port}`,
      scope: String(brand.scope ?? '').trim(),
      fishId: String(brand.fishId ?? '').trim(),
      protocol: proto || '(missing)',
    });
  }
  return out.sort((a, b) => a.port - b.port);
}

/**
 * 合并时间线：按 at 排序、同一条只留一次。
 *
 * 去重键 = **`at|text`（不带 who）**。为什么把说话者排除在外：
 * 实测发现两只宠物**有可能共用同一个 userRoot**（另一份副本用了我的目录），
 * 于是同一条说话记录会同时出现在两个来源的日志里、且 `at` 完全相同 ——
 * 那是**同一条物理记录**，带 who 去重就会显示两遍（实测时间线里每条都重复）。
 * 反过来"两只不同的鱼在同一毫秒说了同样的话"几乎不可能，忽略这个风险是划算的。
 */
export function mergeTimeline(entries, limit = 20) {
  const seen = new Set();
  const out = [];
  for (const item of entries) {
    if (!item || !Number.isFinite(item.at) || typeof item.text !== 'string' || !item.text) continue;
    const key = `${item.at}|${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(-limit);
}

/**
 * 给提示词用的"最近大家说了什么"（一行一条，带相对时间与说话者）。
 *
 * `selfName` 不是装饰：块里自己那几行标的是「我」，但**光有这个字模型不知道自己是谁** ——
 * 实测另一只鱼会把它当别人的话读（用户报的"7350 不认得自己"）。把名字写进块头就解决了。
 */
/**
 * 一行里"谁说的"怎么显示。
 *
 * 重点是**主人的话要带上目标**：主人打字默认是**广播**（两边都能收到），
 * 所以模型必须知道这句话是不是对自己说的 —— 否则两只宠物会同时抢答同一句。
 *   - 主人（对全体说）／主人（对你说）／主人（对「鱼板妹妹7350号」说）
 *   - 其余：说话者名字（自己那份在收集时已标成「我」）
 */
export function speakerLabel(item, selfName = '') {
  const who = String(item?.who ?? '').trim() || '某只';
  const to = typeof item?.to === 'string' ? item.to.trim() : '';
  if (who === '主人' && to) {
    if (to === '*') return '主人（对全体说）';
    if (selfName && to === selfName) return '主人（对你说）';
    return `主人（对「${to}」说）`;
  }
  return who;
}

/**
 * 把时间线渲染成提示词里的一段。
 *
 * `scope` 是**会话隔离**（主人报"好像会走鱼板看"✗→✓）：
 *   - 不传（桌面/周期观察）：**只看本机的内容** ✗ 不看任何 QQ 会话
 *   - 传 `group:<id>` / `private:<id>`（回答某个 QQ 会话时）：看**本会话**的话 + 主人广播，
 *     但**看不到别的会话** ✓（以前 A 群的话会出现在 B 群的上下文里 ✗）
 * 依据是 `addLocal(text, who, { to })` 存下来的会话坐标 ✓。
 */
export function filterByScope(entries, scope = '') {
  const isQq = (e) => /^(group|private):/.test(String(e?.to ?? ''));
  return (entries ?? []).filter((e) => {
    const to = String(e?.to ?? '');
    if (!scope) return !isQq(e);
    if (to === scope) return true;
    return !isQq(e);
  });
}

export function timelineBlock(entries, { limit = 8, now = Date.now(), selfName = '', scope = '' } = {}) {
  const recent = mergeTimeline(filterByScope(entries, scope), limit);
  if (!recent.length) return '';
  const lines = recent.map((item) => {
    const secs = Math.max(0, Math.round((now - item.at) / 1000));
    const ago = secs < 60 ? `${secs}秒前` : secs < 3600 ? `${Math.round(secs / 60)}分钟前` : `${Math.round(secs / 3600)}小时前`;
    const image = item.image ? `［配图：${item.image}］` : '';
    return `- （${ago}）${speakerLabel(item, selfName)}：${item.text}${image}`;
  });
  const me = selfName ? `你是「${selfName}」，标「我」的就是你自己说过的话；` : '';
  return [
    scope
      ? `【鱼板网络：本会话最近说过的话（按时间先后）。${me}标名字的是别的宠物。】`
      : `【鱼板网络：最近这台电脑上几只宠物/主人说过的话（按时间先后）。${me}标名字的是别的宠物。】`,
    ...lines,
    '（你可以顺着别人的话接一句，也可以不理；不要复述这个列表。）',
  ].join('\n');
}

export class FishBoard {
  /**
   * @param {{selfOrigin:string, ports?:number[], pollMs?:number, log?:(m:string)=>void}} options
   */
  constructor(options) {
    this.selfOrigin = String(options.selfOrigin).replace(/\/$/, '');
    this.ports = options.ports?.length ? options.ports : DEFAULT_PORTS;
    this.pollMs = Math.max(1000, Number(options.pollMs ?? 4000));
    this.log = options.log ?? (() => {});
    this.peers = [];
    /** 自己的宠物名字（从自己那份 /gw/brand 读到；提示词块用它说明"我"是谁） */
    this.selfName = '';
    /** 每个来源的游标：origin → 见过的最大 at */
    this.cursors = new Map();
    /** 本地已知的条目（自己的鱼 + 主人说的话） */
    this.local = [];
    this.lastError = '';
    this.lastPollAt = null;
    this.polls = 0;
  }

  /**
   * 主人说的话也进鱼板（"还有用户的聊天记录"）——谁说的由 who 区分。
   *
   * @param {string} text
   * @param {string} who 说话者（主人 / 我）
   * @param {{image?:string, to?:string, at?:number}} [options] `to` = 目标是全体（`*`）还是某只
   */
  addLocal(text, who = '主人', options = {}) {
    if (typeof text !== 'string' || !text.trim()) return;
    const { image, to, at } = typeof options === 'string' ? { image: options } : options;
    this.local.push({
      at: Number.isFinite(at) ? at : Date.now(),
      who,
      text: text.trim(),
      ...(to ? { to } : {}),
      ...(image ? { image } : {}),
      local: true,
    });
    if (this.local.length > MAX_ENTRIES) this.local = this.local.slice(-MAX_ENTRIES);
  }

  /** 发现对等体：逐个端口问 /gpw/brand（握手端点），排除自己 */
  async discover() {
    const brands = [];
    for (const port of this.ports) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/gpw/brand`, { signal: AbortSignal.timeout(600) });
        if (res.ok) brands.push({ ...(await res.json()), port });
      } catch {
        /* 这个端口没有宠物，正常 */
      }
    }
    // 自己那一份 brand 也在结果里：顺手记下名字，供提示词块说明"我"是谁
    const selfPort = Number(new URL(this.selfOrigin).port || 80);
    const mine = brands.find((b) => Number(b.port) === selfPort);
    if (mine && typeof mine.name === 'string' && mine.name) this.selfName = mine.name;

    const next = pickPeers(brands, this.selfOrigin);
    const changed = JSON.stringify(next) !== JSON.stringify(this.peers);
    this.peers = next;
    if (changed) {
      this.log(
        next.length
          ? '鱼板网络：发现 ' + next.map((p) => `${p.name}(${p.port})`).join('、')
          : '鱼板网络：暂时只有自己（对等体需要提供 /gpw/brand）',
      );
    }
    return this.peers;
  }

  /** 拉一轮：自己的鱼 + 各对等体，各自按游标只取更新的 */
  async pollOnce() {
    const origins = [this.selfOrigin, ...this.peers.map((p) => p.origin)];
    const fetched = [];
    for (const origin of origins) {
      const cursor = this.cursors.get(origin) ?? 0;
      try {
        const res = await fetch(origin + '/gpw/log?limit=50', { signal: AbortSignal.timeout(1500) });
        if (!res.ok) continue;
        const data = await res.json();
        const sourceName = origin === this.selfOrigin ? '我' : this.peers.find((p) => p.origin === origin)?.name || origin;
        let maxAt = cursor;
        for (const entry of data?.entries ?? []) {
          if (!Number.isFinite(entry?.at) || typeof entry?.text !== 'string') continue;
          if (entry.at <= cursor) continue; // 游标：只收更新的
          /**
           * ⚠️ **条目自带的 `who` 优先**，只有没写才按来源推断。
           *
           * 踩过的坑：以前一律按"来自哪个端口"标说话者 —— 于是主人经共享通道广播的话
           * （`who:'主人'`）会被标成"我"或对家的名字，两只宠物都以为是对方说的。
           * `to` 同理要带下来：它决定"这句话是不是对我说的"。
           */
          const who = typeof entry.who === 'string' && entry.who.trim() ? entry.who.trim() : sourceName;
          fetched.push({
            at: entry.at,
            who,
            text: entry.text,
            ...(entry.to ? { to: entry.to } : {}),
            ...(entry.image ? { image: entry.image } : {}),
          });
          if (entry.at > maxAt) maxAt = entry.at;
        }
        this.cursors.set(origin, maxAt);
      } catch {
        /* 对等体不在就跳过（对方可能在改代码/重启） */
      }
    }
    if (fetched.length) {
      this.local.push(...fetched);
      if (this.local.length > MAX_ENTRIES) this.local = this.local.slice(-MAX_ENTRIES);
    }
    this.polls += 1;
    this.lastPollAt = Date.now();
    return fetched.length;
  }

  /** 当前时间线（最近 limit 条） */
  timeline(limit = 20) {
    return mergeTimeline(this.local, limit);
  }

  status() {
    return {
      self: this.selfOrigin,
      selfName: this.selfName || '',
      peers: this.peers.map((p) => ({ name: p.name, port: p.port })),
      entries: this.local.length,
      polls: this.polls,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      last: this.timeline(1)[0]?.text ?? '',
    };
  }
}

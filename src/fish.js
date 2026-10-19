/**
 * **鱼（桌宠实例）与端口的统一读写层**。
 *
 * 为什么要有这个模块 ✗→✓：
 *   多鱼是**后来加的** ✓ —— 端口解析（`origin.split(':').pop()` ✓）、按端口/名字认鱼 ✓、
 *   scope 映射 ✓、profile 映射 ✓、"哪条是主鱼" ✓、保活挑选 ✓……原来**散在 index.js 各处** ✗
 *   （`fishFromQuery` / `fishOfScope` / 内联 `.find((f) => …)` 至少四份实现 ✓）。
 *   现在收到这里 ✓：**纯函数** ✓（不碰 config、不碰 IO ✓ 可以单测 ✓），
 *   以后要加"**创建新桌宠**" ✓ 只需要 `makeFish()` + `freePort()` 两个函数 ✓。
 *
 * 约定（与现有行为一致 ✓，别随手改 ✗）：
 *   · `origin` 一律 `http://127.0.0.1:<port>` ✓ 存的时候去掉结尾斜杠 ✓
 *   · `scope`  = 记忆/图库目录的后缀 ✓（`memory-<scope>.json` ✓ `image-catalog-<scope>.json` ✓）
 *   · `profile`= 副本 Electron 的用户目录后缀 ✓（默认 `''` → `~/.dsh/dsh-pet-gpw` ✓
 *       `'second'` → `~/.dsh/dsh-pet-gpw-second` ✓）
 *   · **默认鱼**（7341）与**业务主鱼**（接 QQ 的那条）是**两件事** ✓
 *       —— 混用会把端口搞错 ✓（这个坑踩过两次 ✓ 见 FISHES.md §2 ✓）
 */

/** 端口号的合法范围（分配新鱼用 ✓） */
export const PORT_BASE = 7341;
export const PORT_MAX = 7399;

/** 规范化 origin：去空白、去结尾斜杠 ✓（空串 = 没设 ✓） */
export function normalizeOrigin(raw) {
  return String(raw ?? '').trim().replace(/\/+$/, '');
}

/** 从 origin 里取端口 ✓（取最后一段冒号后的数字 ✓；取不到返回 0 ✓） */
export function portOf(origin) {
  const m = String(origin ?? '').match(/:(\d{2,5})\/?$/);
  const port = m ? Number(m[1]) : 0;
  return Number.isFinite(port) && port > 0 ? port : 0;
}

/** 端口 → origin ✓ */
export function originOfPort(port, host = '127.0.0.1') {
  const n = Number(port);
  return Number.isFinite(n) && n > 0 ? `http://${host}:${n}` : '';
}

/** 这条鱼的 scope（记忆/图库目录后缀 ✓） */
export function scopeOf(fish) {
  const sc = String(fish?.scope ?? '').trim();
  if (sc) return sc;
  return String(fish?.id ?? '').trim();
}

/**
 * 这条鱼的 profile（副本用户目录后缀 ✓）。
 *
 * 规则沿用现状 ✓：鱼表里写了就用 ✓；没写时 **第一只（默认鱼）用空串** ✓、其余用自己的 id ✓。
 * 为什么默认鱼要空串 ✗→✓：它的用户目录是历史遗留的 `~/.dsh/dsh-pet-gpw` ✓，
 * 换名字会把它的记忆/图片全"搬丢" ✓（踩过 ✓）。
 */
export function profileOf(fish, { defaultFishId = 'legacy' } = {}) {
  const explicit = String(fish?.profile ?? '').trim();
  if (explicit) return explicit;
  const id = String(fish?.id ?? '').trim();
  if (!id) return '';
  return id === defaultFishId ? '' : id;
}

/**
 * **认鱼**：给任意组合的线索 ✓（id / scope / 端口 / origin ✓）→ 找到那条鱼 ✓。
 * 找不到返回 null ✓（调用方自己决定兜底 ✓）。
 *
 * 优先级：id > scope > port > origin ✓（id 最明确 ✓）。
 */
export function findFish(pets, hints = {}) {
  const list = Array.isArray(pets) ? pets.filter((f) => f && typeof f === 'object') : [];
  if (!list.length) return null;
  const id = String(hints.id ?? '').trim();
  const scope = String(hints.scope ?? '').trim();
  const port = Number(hints.port ?? 0) || portOf(hints.origin);
  if (id) {
    const hit = list.find((f) => String(f.id ?? '') === id);
    if (hit) return hit;
  }
  if (scope) {
    const hit = list.find((f) => scopeOf(f) === scope);
    if (hit) return hit;
  }
  if (port) {
    const hit = list.find((f) => portOf(f.origin) === port);
    if (hit) return hit;
  }
  return null;
}

/** 端口 → 鱼（`?port=` 的常见用法 ✓） */
export function fishByPort(pets, port) {
  return findFish(pets, { port });
}

/**
 * **业务主鱼** = 接 QQ 的那条 ✓（`qq: true` ✓），没有就退回第一条启用中的鱼 ✓。
 * ⚠️ 它**不是**默认鱼 ✓ —— 默认鱼（7341）只负责"启动器/默认" ✓（见 FISHES.md §2 ✓）。
 */
export function primaryFish(pets) {
  const list = Array.isArray(pets) ? pets.filter((f) => f && typeof f === 'object') : [];
  return list.find((f) => f.qq === true && f.enabled !== false) || list.find((f) => f.enabled !== false) || list[0] || null;
}

/** 默认鱼 = 鱼表里 profile 为空的那条（＝ 7341 那只 ✓） */
export function defaultFish(pets) {
  const list = Array.isArray(pets) ? pets.filter((f) => f && typeof f === 'object') : [];
  return list.find((f) => profileOf(f) === '') || list[0] || null;
}

/** 启用中的鱼（总闸关掉 = 一条都不驱动 ✓） */
export function enabledFish(pets, petsEnabled = true) {
  if (petsEnabled === false) return [];
  return (Array.isArray(pets) ? pets : []).filter((f) => f && typeof f === 'object' && f.enabled !== false);
}

/** 下一个可用端口 ✓（给"创建新桌宠"用 ✓：`origin` 已占用的跳过 ✓） */
export function freePort(pets, { start = PORT_BASE, max = PORT_MAX } = {}) {
  const used = new Set(
    (Array.isArray(pets) ? pets : []).map((f) => portOf(f?.origin)).filter((p) => p > 0),
  );
  for (let p = Math.max(start, PORT_BASE); p <= max; p += 1) {
    if (!used.has(p)) return p;
  }
  return 0;
}

/** 起个不撞的 id ✓（`fish2` 这种 ✓；新建桌宠用 ✓） */
export function uniqueFishId(pets, base = 'fish') {
  const ids = new Set((Array.isArray(pets) ? pets : []).map((f) => String(f?.id ?? '')));
  const stem = String(base || 'fish').replace(/[^\w-]+/g, '') || 'fish';
  if (!ids.has(stem)) return stem;
  for (let i = 2; i < 1000; i += 1) {
    if (!ids.has(stem + i)) return stem + i;
  }
  return stem + Date.now();
}

/**
 * **造一条新鱼**（"创建新桌宠"的唯一入口 ✓）。
 *
 * 只生成**数据** ✓：端口没给就自动挑 ✓、id 没给就自动起 ✓、scope 默认等于 id ✓、profile 默认等于 id ✓
 * （默认鱼之外的鱼各有独立用户目录 ✓ 记忆/图片互不干扰 ✓）。
 *
 *   const next = makeFish({ pets, name: '小蓝', port: 0, qq: false });
 *   // → 把它 push 进 config.pets ✓ 然后 ensureFork() 就会拉起它 ✓
 */
export function makeFish({ pets = [], name = '', port = 0, qq = false, qqAccount = '', personality = '', rules = '', profile = '', onebotUrl = '', onebotToken = '' } = {}) {
  const picked = Number(port) > 0 ? Number(port) : freePort(pets);
  if (!picked) throw new Error('没有可用端口了（' + PORT_BASE + '–' + PORT_MAX + ' 全被占用）');
  if ((Array.isArray(pets) ? pets : []).some((f) => portOf(f?.origin) === picked)) {
    throw new Error('端口已被占用：' + picked);
  }
  const id = uniqueFishId(pets);
  return {
    id,
    name: String(name || `桌宠 ${picked}`).trim(),
    origin: originOfPort(picked),
    enabled: true,
    scope: id,
    qq: qq === true,
    profile: String(profile || id).trim(),
    personality: String(personality || ''),
    rules: String(rules || ''),
    /** QQ 号绑定（按鱼 ✓；留空 = 用全局 onebotUrl/Token ✓） */
    qqAccount: String(qqAccount || '').trim(),
    onebotUrl: String(onebotUrl || '').trim(),
    onebotToken: String(onebotToken || '').trim(),
  };
}

/**
 * **这条鱼用哪个 QQ 账号 / 哪个 OneBot 端点** ✓（纯函数 ✓ 可单测 ✓）。
 *
 * 绑定是**按鱼**的 ✓：`fish.qqAccount`（自己的号 ✓）、`fish.onebotUrl` / `fish.onebotToken`
 * （那个号对应的 OneBot 端点 ✓ —— NapCat 一个号一个端点 ✓）。
 * 没绑就回落到**全局**配置 ✓（`config.onebotUrl/Token` ✓）→ 兼容现在的单号用法 ✓。
 *
 * 返回 `{ account, url, token, bound, source }` ✓：
 *   bound  = 这条鱼是否有**自己的**绑定 ✓（false = 用的是全局）
 *   usable = url 非空（能不能连 ✓）
 */
export function qqOf(fish, config = {}) {
  const ownUrl = String(fish?.onebotUrl ?? '').trim();
  const ownToken = String(fish?.onebotToken ?? '').trim();
  const ownAccount = String(fish?.qqAccount ?? '').trim();
  const url = ownUrl || String(config?.onebotUrl ?? '').trim();
  const token = ownToken || String(config?.onebotToken ?? '').trim();
  const account = ownAccount || String(config?.qqAccount ?? '').trim();
  return {
    account,
    url,
    token,
    usable: Boolean(url),
    bound: Boolean(ownUrl || ownAccount),
    source: ownUrl || ownAccount ? 'fish' : 'global',
  };
}

/** 打码（日志/接口里绝不回显完整 token ✗） */
export function maskSecret(raw) {
  const s = String(raw ?? '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

/** 一行摘要（日志用 ✓ 别在日志里手拼字段 ✗） */
export function summarize(fish) {
  if (!fish) return '(none)';
  const port = portOf(fish.origin) || '?';
  return `${fish.name || fish.id}(${port}${fish.qq ? '·QQ' : ''}${fish.enabled === false ? '·停' : ''})`;
}

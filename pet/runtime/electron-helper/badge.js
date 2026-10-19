/**
 * 「观察中」胶囊小窗的脚本（**只有胶囊**，输入框在另一个小窗）。
 *
 *   ① 轮询插件状态 → 更新文字与状态灯；
 *   ② 点文字（.label）→ 切换置顶固定（原版语义：**不动点击穿透**）；
 *   ③ 点 ▤（.panel）→ 打开**观察面板**。
 *      ⚠️ 面板入口以前在浮层里，浮层搬到独立小窗时丢了，面板就再也打不开 —— 这里必须保留。
 *      做成独立小元素是为了不跟"点胶囊切置顶"抢同一个点击区域。
 */
const q = new URLSearchParams(location.search);
const PORT = q.get('port') || '7341';
/**
 * **插件地址不能只在窗口加载时取一次**（2026-10-18 修：胶囊永远显示"插件离线"）。
 *
 * 窗口 URL 里的 `?plugin=` 是**建窗那一刻**的快照；DSH 每次重启端口都会变，
 * 之后胶囊就一直轮询那个死端口 → 状态永远 `catch` → "插件离线"。
 * 这个页面是 `file://` 源，所以必须用**绝对地址**问宠物自己的服务：
 *   http://127.0.0.1:<宠物端口>/gpw/brand → 里面的 pluginOrigin 就是当前该连的地址
 * （宠物服务的响应已加 CORS，file:// 也能读）。
 */
let PLUGIN = (q.get('plugin') || 'http://127.0.0.1:19387').replace(/\/$/, '');
let API = PLUGIN + '/game-pet-watch';
const PET_API = 'http://127.0.0.1:' + PORT;
async function refreshPluginOrigin() {
  try {
    const res = await fetch(PET_API + '/gpw/brand', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (!res.ok) return;
    const data = await res.json();
    const next = typeof data?.pluginOrigin === 'string' ? data.pluginOrigin.replace(/\/$/, '') : '';
    if (next && next !== PLUGIN) {
      PLUGIN = next;
      API = PLUGIN + '/game-pet-watch';
    }
  } catch {
    /* 宠物服务自己不可用：保持原样 */
  }
}
const THEME = { ok: '#3fb950', warn: '#e0a53c', err: '#e2564a', dim: '#9a9aa8' };

/**
 * 宠物名字：只用于**区分同时跑的多只宠物**（例如 DSH 这只叫"小蓝"、另一个仓库那只叫"小红"）。
 * 从副本自己的 prefs 读，和 pin 一样属于"副本自身状态"，不走插件。
 */
let petName = '';
async function pollName() {
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/gpw/prefs', { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    const next = typeof data?.prefs?.petName === 'string' ? data.prefs.petName : '';
    if (next !== petName) {
      petName = next;
      // 名字变了：宽度跟着变（胶囊窗是按内容自适应的，见 reportWidth）
      void reportWidth();
    }
  } catch {
    /* 读不到就保持原样 */
  }
}

/**
 * 把胶囊需要的宽度报给主进程（它按内容调窗口宽度）。
 * 为什么需要：名字长度不定，窗口写死宽度会把名字截掉；
 * 而**只有高度**会被 Windows 强制最小值夹住（曾经踩过死循环），宽度可以随时调。
 */
async function reportWidth() {
  // 等一帧让文字排版稳定再量
  await new Promise((r) => requestAnimationFrame(() => r()));
  const width = Math.ceil(badge.getBoundingClientRect().width) + 10;
  if (window.gpwBadge?.reportWidth) window.gpwBadge.reportWidth(width);
}

const badge = document.getElementById('badge');
const dot = badge.querySelector('.dot');
const label = badge.querySelector('.label');
const panel = badge.querySelector('.panel');
const pin = badge.querySelector('.pin');

async function poll() {
  try {
    /**
     * ⚠️ **必须带上自己的端口** ✗→✓：插件的 `/state` 默认返回"主鱼"那份记忆 ✗，
     * 于是**两只鱼的胶囊显示同一份记忆** ✓（主人报"记忆混在一起" ✓ 就是这个 ✓）。
     * 带上 `?port=` 后，插件按端口认出是哪条鱼 ✓ → 返回它自己的记忆 ✓。
     */
    const res = await fetch(API + '/state?port=' + encodeURIComponent(PORT), { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    const r = data?.runtime ?? {};
    const errors = data?.errors ?? [];
    /**
     * 先判"这个响应是不是正常的状态结构"。
     *
     * 踩过的坑：插件某个接口写错时 `/state` 会返回 **HTTP 200 + `{error:"collector is not defined"}`**
     * —— 拿到 200 就往下走，`runtime` 是 undefined，于是 `running=false`，
     * 胶囊显示「未运行」，可宠物明明在正常观察。**界面撒谎比不显示更糟**。
     * 正常响应必有 runtime.running（布尔），没有就说明接口坏了，明确报出来。
     */
    if (!r || typeof r.running !== 'boolean') {
      dot.style.background = THEME.err;
      label.textContent = (petName ? petName + ' · ' : '') + '状态异常' + (data?.error ? ' · ' + String(data.error).slice(0, 14) : '');
      void reportWidth();
      return;
    }
    const running = Boolean(r.running);
    const paused = Boolean(r.paused);
    dot.style.background = errors.length ? THEME.err : paused && !running ? THEME.warn : running ? THEME.ok : THEME.dim;
    label.textContent =
      (petName ? petName + ' · ' : '') +
      (paused && !running ? '已暂停 · ' : running ? '观察中 · ' : '未运行 · ') +
      (data?.memory?.total ?? 0);
  } catch {
    dot.style.background = THEME.dim;
    label.textContent = (petName ? petName + ' · ' : '') + '插件离线';
    // 失败就立刻问一次"现在的插件地址"（DSH 重启换端口后，下一轮就恢复成"观察中"）
    void refreshPluginOrigin();
  }
  void reportWidth();
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/gpw/pin', { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    pin.classList.toggle('on', data?.pinned === true);
  } catch {
    /* 副本没起来就不显示图钉状态 */
  }
}

/** 点文字：切换置顶固定 */
label.addEventListener('click', async () => {
  try {
    const cur = await (await fetch('http://127.0.0.1:' + PORT + '/gpw/pin')).json();
    const next = !(cur?.pinned === true);
    await fetch('http://127.0.0.1:' + PORT + '/gpw/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: next }),
    });
    pin.classList.toggle('on', next);
  } catch {
    /* 失败就等下一轮轮询自然纠正显示 */
  }
});

/** 点 ▤：打开观察面板 */
panel.addEventListener('click', () => {
  if (window.gpwBadge && typeof window.gpwBadge.openPanel === 'function') window.gpwBadge.openPanel();
});

void refreshPluginOrigin();
setInterval(() => void refreshPluginOrigin(), 10000);
void pollName();
setInterval(() => void pollName(), 5000);
void poll();
setInterval(() => void poll(), 2000);

/**
 * 自检：连到 dsh-pet-gpw 的 DevTools，读页面真相（不靠猜）。
 *
 *   node scripts/gpw-inspect.mjs                  # 打印宠物/浮层/视频/错误
 *   node scripts/gpw-inspect.mjs --say "你好"     # 顺便推一句话，验证气泡链路
 *   node scripts/gpw-inspect.mjs --raw '<js>'     # 在页面里求值任意表达式
 *
 * 依赖：目标进程要带 --remote-debugging-port=9222（gpw-start 不默认开，排障时手动加）。
 */
const PORT = process.env.GPW_DEBUG_PORT || '9222';
const args = process.argv.slice(2);

async function target() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  // --window <标题子串>：多窗口时选目标（宠物窗 / 面板窗）。不指定就优先宠物窗。
  const wi = args.indexOf('--window');
  const want = wi !== -1 && args[wi + 1] ? args[wi + 1] : null;
  const pages = list.filter((t) => t.type === 'page');
  const page = want
    ? pages.find((t) => (t.title || '').includes(want))
    : pages.find((t) => t.url.includes('index-gpw')) || pages[0];
  if (!page) throw new Error('没找到页面调试目标' + (want ? `（标题含 ${want}）` : ''));
  return page;
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return {
    ready,
    send(method, params) {
      const mid = ++id;
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

const PROBE = `(() => {
  const stage = document.querySelector('.pet-stage');
  const sprite = document.querySelector('.pet-sprite');
  const hit = document.querySelector('.pet-hit');
  const videos = Array.from(document.querySelectorAll('video.pet-video')).map(v => ({
    cls: v.className, src: (v.currentSrc||v.src||'').split('/').pop(), readyState: v.readyState,
    paused: v.paused, w: v.videoWidth, h: v.videoHeight, opacity: getComputedStyle(v).opacity,
  }));
  const rect = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; };
  return JSON.stringify({
    debug: window.__dshPetDebug || null,
    hasGpwHost: !!window.gpwHost,
    hasPetBridge: !!window.petBridge,
    rootChildren: document.getElementById('root')?.children.length ?? -1,
    sprite: rect(sprite), stage: rect(stage), hit: rect(hit),
    videos,
    input: (() => { const i = document.getElementById('gpw-input'); return i ? { cls: i.className, rect: rect(i) } : null; })(),
    badge: (() => { const b = document.getElementById('gpw-badge'); return b ? { cls: b.className, text: b.textContent.trim(), rect: rect(b) } : null; })(),
    errorText: document.getElementById('pet-error')?.textContent || '',
    bodyText: document.body.innerText.slice(0, 200),
  }, null, 1);
})()`;

const page = await target();
const client = connect(page.webSocketDebuggerUrl);
await client.ready;
await client.send('Runtime.enable');

if (args.includes('--say')) {
  const i = args.indexOf('--say');
  const text = args[i + 1] || '自检一句话';
  const res = await fetch('http://127.0.0.1:7341/gpw/say', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, pet: 'main' }),
  });
  console.log('say ->', await res.json());
  await new Promise((r) => setTimeout(r, 1500));
}

const expression = args.includes('--raw') ? args[args.indexOf('--raw') + 1] : PROBE;
const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
const value = result?.result?.value;
if (typeof value === 'string' && !args.includes('--raw')) console.log(value);
else if (args.includes('--raw')) console.log(JSON.stringify(value, null, 1));
else console.log(JSON.stringify(value, null, 1));
if (result?.exceptionDetails) console.log('EXCEPTION:', JSON.stringify(result.exceptionDetails).slice(0, 400));

client.close();

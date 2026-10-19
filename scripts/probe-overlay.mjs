/**
 * **在真页面里查"插件离线"**（诊断脚本，不是产品代码）。
 *
 *   node scripts/probe-overlay.mjs
 *
 * 做法：起一只**带 --remote-debugging-port 的临时宠物**（自己的端口/用户目录），
 * 用 CDP（Chrome DevTools Protocol）连到它那个页面，然后：
 *   · 读徽标文字（badge 到底写了什么）
 *   · 在页面里亲自跑那两条 fetch（brand → pluginOrigin → /state），把浏览器的报错原样打出来
 *   · 收集 console / exception
 *
 * 为什么必须这么做：curl 不执行 CORS、也不跑页面里的 JS，"我这边好的"和"界面离线"可以同时成立。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PET_REPO = process.env.GPW_SANDBOX_PET_REPO || join(dirname(ROOT), 'dsh-pet-gpw');
const TEMP = join(tmpdir(), `gpw-probe-overlay-${Date.now()}`);
const USER = join(TEMP, 'pet');
const PORT = 7396;
const CDP = 9333;
const PLUGIN = process.env.GPW_PROBE_PLUGIN || 'http://127.0.0.1:19387';

mkdirSync(USER, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(env)) if (k.toUpperCase() === 'GPW_UPSTREAM_ROOT') delete env[k];
Object.assign(env, {
  GPW_PORT: String(PORT),
  GPW_USER_ROOT: USER,
  GPW_PET_ID: 'probe',
  GPW_FISH_ID: 'probe',
  GPW_PLUGIN_ORIGIN: PLUGIN,
  DSH_PET_HOST_PID: String(process.pid),
  DSH_PET_FORCE_DSF: '1',
});

const pet = spawn(join(homedir(), '.dsh', 'electron', 'electron.exe'), [join(PET_REPO, 'runtime', 'gpw-main.cjs'), `--remote-debugging-port=${CDP}`], {
  cwd: PET_REPO,
  stdio: 'ignore',
  windowsHide: true,
  env,
});
console.log(`临时宠物 pid=${pet.pid}，端口 ${PORT}，CDP ${CDP}，插件地址 ${PLUGIN}`);

let target = null;
for (let i = 0; i < 60 && !target; i += 1) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const want = process.env.GPW_PROBE_TARGET === 'badge' ? 'badge.html' : 'index-gpw';
    target = list.find((t) => t.type === 'page' && String(t.url).includes(want));
  } catch {
    /* 还没开调试口 */
  }
}
if (!target) {
  console.log('❌ 没找到宠物页面（调试口没开？）');
  pet.kill();
  process.exit(2);
}
console.log('页面:', target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method) {
    events.push(msg);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Runtime.enable');
await send('Log.enable');
await sleep(6000); // 让浮层跑几轮

const evalIn = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) return { error: res.result.exceptionDetails.text + ' ' + (res.result.exceptionDetails.exception?.description ?? '') };
  return { value: res.result?.result?.value };
};

console.log('\n=== 页面自检 ===');
console.log('  浮层装上了吗:', JSON.stringify(await evalIn('!!window.__gpwOverlayInstalled')));
console.log('  有 petBridge 吗:', JSON.stringify(await evalIn('!!window.petBridge')));
console.log('  location:', JSON.stringify(await evalIn('location.href')));
console.log(
  '  徽标文字:',
  JSON.stringify(
    await evalIn(
      `(function(){var els=[...document.querySelectorAll('*')].filter(function(e){return e.children.length===0 && /插件离线|观察中|已暂停/.test(e.textContent||'')});return els.map(function(e){return e.textContent.trim()}).slice(0,5)})()`,
    ),
  ),
);

console.log('\n=== 页面里亲自跑那两条 fetch ===');
const brand = await evalIn(`fetch('http://127.0.0.1:${PORT}/gpw/brand').then(r=>r.text()).catch(e=>'ERR: '+e)`);
console.log('  /gpw/brand →', JSON.stringify(brand).slice(0, 300));
let origin = '';
try {
  origin = JSON.parse(typeof brand.value === 'string' ? brand.value : '{}').pluginOrigin || '';
} catch {
  /* 上面会打印原始内容 */
}
if (origin) {
  const state = await evalIn(`fetch(${JSON.stringify(origin + '/game-pet-watch/state')}).then(async r=>r.status+' '+((await r.text()).slice(0,120))).catch(e=>'ERR: '+e)`);
  console.log(`  ${origin}/game-pet-watch/state →`, JSON.stringify(state).slice(0, 300));
}

console.log('\n=== console / 异常（最近 12 条）===');
for (const e of events.filter((x) => x.method === 'Log.entryAdded' || x.method === 'Runtime.exceptionThrown').slice(-12)) {
  if (e.method === 'Log.entryAdded') console.log('  [log]', e.params.entry.level, e.params.entry.text.slice(0, 200));
  else console.log('  [exception]', (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text || '').slice(0, 200));
}

ws.close();
try {
  pet.kill();
} catch {
  /* 忽略 */
}
await sleep(1000);
rmSync(TEMP, { recursive: true, force: true });
process.exit(0);

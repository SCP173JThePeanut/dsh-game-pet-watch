/**
 * 诊断：杀掉宠物主进程之后，还有没有东西在继续往插件 POST /rects？
 * 结论决定"幽灵包围盒"的根因：是"没删"还是"尸体还在上报"。
 */
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PET_REPO = process.env.GPW_SANDBOX_PET_REPO || join(dirname(ROOT), 'dsh-pet-gpw');
const TEMP = join(tmpdir(), `gpw-probe-${Date.now()}`);
const USER = join(TEMP, 'pet');
mkdirSync(USER, { recursive: true });

const hits = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    hits.push({ at: Date.now(), method: req.method, url: req.url });
    if (req.url.startsWith('/game-pet-watch/rects') && req.method === 'POST') res.end(JSON.stringify({ ok: true, id: 'probe' }));
    else if (req.url.startsWith('/game-pet-watch/rects')) res.end(JSON.stringify({ ok: true, rects: {} }));
    else res.end('{}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(env)) if (k.toUpperCase() === 'GPW_UPSTREAM_ROOT') delete env[k];
Object.assign(env, {
  GPW_PORT: '7397',
  GPW_USER_ROOT: USER,
  GPW_PET_ID: 'probe',
  GPW_FISH_ID: 'probe',
  GPW_PLUGIN_ORIGIN: origin,
  DSH_PET_HOST_PID: String(process.pid),
  DSH_PET_FORCE_DSF: '1',
});
const pet = spawn(join(homedir(), '.dsh', 'electron', 'electron.exe'), [join(PET_REPO, 'runtime', 'gpw-main.cjs')], {
  cwd: PET_REPO,
  stdio: 'ignore',
  windowsHide: true,
  env,
});
console.log(`宠物 pid=${pet.pid}，观察 6 秒…`);
await new Promise((r) => setTimeout(r, 6000));
const before = hits.filter((h) => h.method === 'POST' && h.url.includes('/rects')).length;
console.log(`  杀之前 POST 次数 = ${before}`);

try {
  execSync(`taskkill /F /T /PID ${pet.pid}`, { stdio: 'ignore' });
} catch {
  /* 已经退了 */
}
const killedAt = Date.now();
console.log('  已 taskkill /F /T');
await new Promise((r) => setTimeout(r, 10000));
/** 杀进程那一刻**已经在路上**的请求（+几毫秒）不算幽灵 —— 只看 300ms 之后还有没有新的 */
const after = hits.filter((h) => h.at > killedAt + 300);
console.log(`  杀之后 10 秒内的请求数 = ${after.length}`);
for (const h of after.slice(0, 6)) console.log(`    +${h.at - killedAt}ms ${h.method} ${h.url}`);
console.log(after.length === 0 ? '\n✅ 尸体没有继续上报' : '\n❌ 还有东西在继续上报（幽灵来源）');

try {
  execSync('netstat -ano | findstr :7397', { stdio: 'ignore' });
  console.log('（7397 仍在监听）');
} catch {
  console.log('（7397 已释放）');
}
server.close();
rmSync(TEMP, { recursive: true, force: true });
process.exit(after.length === 0 ? 0 : 1);

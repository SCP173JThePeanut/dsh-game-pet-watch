/**
 * 退出耦合的端到端验证（**不需要重启 DSH**）。
 *
 * 做法：
 *   ① 起一个短命 node 进程当"假 DSH 宿主"；
 *   ② 用 launcher 拉起副本，并把假宿主的 pid 作为 hostPid；
 *   ③ 确认副本活着（TCP 探活）；
 *   ④ 杀掉假宿主；
 *   ⑤ 看副本是否在 HOST_POLL_MS（2 秒）左右的窗口内自己退出。
 *
 * 这条链路是"DSH 关 → 宠物自己消失"的完整机制验证：
 * 插件传 hostPid → 启动器注入 DSH_PET_HOST_PID → 副本助手每 2 秒 kill(pid,0) 探测 → ESRCH 就退出。
 *
 *   node scripts/verify-exit-coupling.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
// Windows 上动态 import 绝对路径必须先转成 file:// URL，否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const launcherUrl = pathToFileURL(join(PACKAGE_ROOT, '..', 'dsh-game-pet-watch', 'src', 'launcher.js')).href;
const { launchFork, forkAlive } = await import(launcherUrl);

// 用**另一个端口**验证：插件的保活每 15 秒会补一个 7341 的副本，抢不过它；
// 退出耦合的机制与端口无关，所以换端口测最干净。
const PORT = process.env.VERIFY_PORT || '7399';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const UPSTREAM = 'C:/Users/Kishin/.dsh/profiles/desktop/node_modules/dsh-pet';

console.log('① 起一个假宿主进程…');
const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: false });
console.log('   假宿主 pid =', host.pid);
await new Promise((r) => setTimeout(r, 500));

console.log('② 拉起副本，hostPid = 假宿主…');
const result = await launchFork({
  packageRoot: PACKAGE_ROOT,
  origin: ORIGIN,
  upstreamRoot: UPSTREAM,
  pluginOrigin: 'http://127.0.0.1:19387',
  hostPid: host.pid,
  // 让副本用另一个端口（launcher 从 origin 里取端口）

  log: (m) => console.log('   [launcher]', m),
});
console.log('   拉起结果:', JSON.stringify(result));
if (!result.ok) {
  console.log('   （副本没起来，无法继续验证）');
  host.kill();
  process.exit(1);
}

console.log('③ 等副本就绪…');
let alive = false;
for (let i = 0; i < 20; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  alive = await forkAlive(ORIGIN);
  if (alive) {
    console.log(`   副本已就绪（${i + 1}s）`);
    break;
  }
}
if (!alive) {
  console.log('   副本始终没起来，验证中止');
  host.kill();
  process.exit(1);
}

console.log('④ 杀掉假宿主（模拟 DSH 退出）…');
host.kill('SIGKILL');
const killedAt = Date.now();

console.log('⑤ 等副本自己退出（助手每 2 秒探一次）…');
let gone = false;
for (let i = 0; i < 20; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  const still = await forkAlive(ORIGIN);
  if (!still) {
    gone = true;
    console.log(`   ✅ 副本已自己退出，用时 ${((Date.now() - killedAt) / 1000).toFixed(1)}s`);
    break;
  }
  console.log(`   …${i + 1}s 还在`);
}
if (!gone) {
  console.log('   ❌ 副本没有退出 —— 退出耦合没生效');
  process.exit(2);
}
console.log('');
console.log('结论：宿主消失 → 副本自动退出，链路端到端可用。');

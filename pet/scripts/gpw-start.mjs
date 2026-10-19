/**
 * 启动 dsh-pet-gpw（独立副本桌宠 + 悬浮输入框 + 观察面板）。
 *
 *   node scripts/gpw-start.mjs                 # 启动（已在跑就提示，不重复开）
 *   node scripts/gpw-start.mjs --restart       # 先停掉再启动
 *   node scripts/gpw-start.mjs --stop          # 停掉
 *   node scripts/gpw-start.mjs --port 7342     # 换端口（同时要改插件的 gpwOrigin）
 *
 * ## 多鱼（同时养好几只）
 *   node scripts/gpw-start.mjs --profile second --port 7342 --name 鱼板妹妹7342
 *   node scripts/gpw-start.mjs --profile second --stop      # 只停这一只
 *   node scripts/gpw-start.mjs --profile second --restart
 *
 * `--profile <名字>` 给这一只**独立的用户目录** `~/.dsh/dsh-pet-gpw-<名字>`：
 * 名字、状态、日志、pid 文件全都分开 ✓ —— 不加 `--profile` 就是老的那只
 * （`~/.dsh/dsh-pet-gpw`，行为与以前完全一样 ✓，互不影响 ✓）。
 * `--name <名字>` 会在启动前把这只鱼的显示名写进它自己的 prefs ✓。
 *   node scripts/gpw-start.mjs --stay          # （默认就是）不跟随任何宿主，独立存活
 *
 * ## 独立性（重要）
 * 副本是**独立 Electron 进程**，只在两种情况下退出：① 你停它 ② 它自己崩了。
 * 它 **不** 跟随 DSH：不传 DSH_PET_HOST_PID（原版的"宿主死了就自杀"探测），
 * 也不挂在 DSH 的进程树里 —— 从桌面快捷方式 / 任务计划启动时，父进程是 explorer/taskeng，
 * DSH 开关与它无关。
 *
 * 但"说话的大脑"（截屏 + 模型裁决 + 记忆）是 DSH 插件 `dsh-game-pet-watch` 提供的：
 * **DSH 关掉时宠物照样在桌面上动，只是状态胶囊显示"插件离线"、输入框发出去没人接**。
 * 想要完整的鱼，就得让 DSH 也开着。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

/**
 * 多鱼支持 ✓：`--profile X` → 独立的用户目录与 pid 文件。
 * 不传就是老那只（`~/.dsh/dsh-pet-gpw`）✓ —— 保证"这只保持现状"不被影响 ✓。
 * ⚠️ 必须在 USER_ROOT **之前**定义 ✗→✓（第一版写在后面，直接 TDZ 报错 ✓）。
 */
const PROFILE = argOf('--profile', '').trim().replace(/[^\w.-]+/g, '_');
const PET_NAME = argOf('--name', '').trim();

const USER_ROOT = PROFILE
  ? join(homedir(), '.dsh', `dsh-pet-gpw-${PROFILE}`)
  : join(homedir(), '.dsh', 'dsh-pet-gpw');
const PID_FILE = join(USER_ROOT, 'helper.pid'); // 每个 profile 自己的 pid ✓（--stop 不会杀错鱼 ✓）
const UPSTREAM_ROOT = argOf('--upstream', 'C:\\Users\\Kishin\\.dsh\\profiles\\desktop\\node_modules\\dsh-pet');
const PORT = argOf('--port', '7341');
const PLUGIN_ORIGIN = argOf('--plugin', 'http://127.0.0.1:19387');
const STATE_URL = `http://127.0.0.1:${PORT}/gpw/state`;

function resolveElectron() {
  const candidates = [
    process.env.GPW_ELECTRON,
    process.env.DSH_PET_ELECTRON_PATH,
    join(homedir(), '.dsh', 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return undefined;
}

async function isRunning() {
  try {
    const res = await fetch(STATE_URL, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

function stop() {
  if (!existsSync(PID_FILE)) return false;
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  try {
    process.kill(pid);
    return pid;
  } catch {
    return false;
  }
}

/**
 * `--list`：把 `~/.dsh/dsh-pet-gpw*` 全部列出来（端口、pid、活着没）。
 *
 * ⚠️ 控制台**只打 ASCII** ✗→✓：Windows 控制台是 GBK，中文名字会变乱码 ✓，
 * 所以名字写进 UTF-8 文件 `fish-list.txt` ✓（用 VS Code/记事本打开看 ✓）。
 */
if (argv.includes('--list')) {
  const dshHome = join(homedir(), '.dsh');
  const dirs = [];
  for (const name of (() => {
    try {
      return readdirSync(dshHome);
    } catch {
      return [];
    }
  })()) {
    if (name === 'dsh-pet-gpw' || name.startsWith('dsh-pet-gpw-')) dirs.push(name);
  }
  dirs.sort();
  const rows = [];
  const out = [];
  for (const name of dirs) {
    const root = join(dshHome, name);
    let prefs = {};
    try {
      prefs = JSON.parse(readFileSync(join(root, 'prefs.json'), 'utf8'));
    } catch {
      prefs = {};
    }
    const port = Number(prefs.port || (name === 'dsh-pet-gpw' ? 7341 : 0));
    let alive = false;
    let brandName = '';
    if (port) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/gpw/brand`, { signal: AbortSignal.timeout(1200) });
        if (r.ok) {
          const b = await r.json();
          alive = true;
          brandName = String(b?.name ?? '');
        }
      } catch {
        alive = false;
      }
    }
    let pid = '';
    try {
      pid = readFileSync(join(root, 'helper.pid'), 'utf8').trim();
    } catch {
      pid = '';
    }
    rows.push({ name, port, alive, pid });
    out.push(`${alive ? '[alive]' : '[down ]'} port=${port || '?'} pid=${pid || '-'} dir=${name} name=${brandName || prefs.petName || ''}`);
  }
  console.log('=== fish ===');
  for (const r of rows) {
    console.log(`  ${r.alive ? 'alive' : 'down '}  port=${r.port || '?'}  pid=${r.pid || '-'}  dir=${r.name}`);
  }
  writeFileSync(join(PACKAGE_ROOT, 'fish-list.txt'), out.join('\n') + '\n', 'utf8');
  console.log(`  ${rows.length} fish; names (UTF-8) -> ${join(PACKAGE_ROOT, 'fish-list.txt')}`);
  /**
   * 收尾：等一小会让 fetch 句柄关干净，再退出 ✓。
   * 直接用 process.exit 会在 Windows 上打一句 libuv 断言噪音 ✗；
   * 不退出又会让脚本继续往下跑、掉进"已经在跑"分支 ✗（第一版就是这么错的 ✓）。
   */
  await new Promise((r) => setTimeout(r, 300));
  process.exit(0);
}

if (argv.includes('--stop')) {
  const pid = stop();
  console.log(pid ? `已请求退出副本 pid=${pid}` : '副本没在跑（或 pid 文件已过期）');
  try {
    rmSync(PID_FILE, { force: true });
  } catch {
    /* 无所谓 */
  }
  process.exit(0);
}

if (await isRunning()) {
  if (!argv.includes('--restart')) {
    console.log(`副本已经在跑（${STATE_URL} 有响应）。要重开就加 --restart。`);
    process.exit(0);
  }
  const pid = stop();
  console.log(pid ? `先停掉旧副本 pid=${pid}` : '旧 pid 无效，继续启动');
  await new Promise((r) => setTimeout(r, 2500));
}

const electron = resolveElectron();
if (!electron) {
  console.error('找不到 Electron。设 GPW_ELECTRON 环境变量，或让原版 dsh-pet 先把 ~/.dsh/electron 装好。');
  process.exit(2);
}
if (!existsSync(UPSTREAM_ROOT)) {
  console.error('找不到原版 dsh-pet 包目录（素材来源）：' + UPSTREAM_ROOT + '（用 --upstream 指定）');
  process.exit(2);
}

mkdirSync(USER_ROOT, { recursive: true });

// `--name` → 写进这只鱼自己的 prefs.json（它只在**自己的**目录里 ✓，别的鱼看不到 ✓）
if (PET_NAME) {
  const prefsFile = join(USER_ROOT, 'prefs.json');
  let prefs = {};
  try {
    prefs = JSON.parse(readFileSync(prefsFile, 'utf8'));
  } catch {
    prefs = {};
  }
  let dirty = false;
  if (PET_NAME && prefs.petName !== PET_NAME) {
    prefs.petName = PET_NAME;
    dirty = true;
  }
  if (Number(prefs.port) !== Number(PORT)) {
    prefs.port = Number(PORT); // 记下端口 ✓ —— `--list` 靠它认出每只鱼在哪个口 ✓
    dirty = true;
  }
  if (dirty) {
    writeFileSync(prefsFile, JSON.stringify(prefs, null, 2), 'utf8');
    console.log('这只鱼的名字/端口已写入：' + prefsFile);
  }
}
const env = {
  ...process.env,
  // 关键：ELECTRON_RUN_AS_NODE 会让 Electron 以纯 Node 模式启动（没有 electron 模块）——必须删掉
  ELECTRON_RUN_AS_NODE: undefined,
  GPW_UPSTREAM_ROOT: UPSTREAM_ROOT,
  GPW_USER_ROOT: USER_ROOT,
  GPW_PORT: String(PORT),
  GPW_PLUGIN_ORIGIN: PLUGIN_ORIGIN,
  /**
   * 鱼板网络 v2 的身份字段（握手 GET /gpw/brand 回给对等体）。
   * 插件自己拉起副本时会注入这两项；这里是**手动启动**的等价物 ——
   * 不设的话脚本起的副本 scope 是空的，对等体就只能靠端口猜身份。
   * scope 约定与鱼表一致：默认那只 = 'legacy'，--profile <名> 那只 = 该 profile 名。
   */
  /** 共享图库目录：默认那只的用户目录就是共享库所在 ✓（脚本手动起时也照这个来 ✓） */
  GPW_SHARED_MEMES:
    process.env.GPW_SHARED_MEMES || 'C:\\Users\\Kishin\\.dsh\\dsh-pet-gpw\\memes',
  GPW_FISH_SCOPE: process.env.GPW_FISH_SCOPE || (PROFILE ? String(PROFILE) : 'legacy'),
  GPW_FISH_ID: process.env.GPW_FISH_ID || (PROFILE ? String(PROFILE) : 'legacy'),
  // 关掉原版助手的 DPI 补偿（它按错误几何把窗口摆到屏幕外）
  DSH_PET_FORCE_DSF: process.env.DSH_PET_FORCE_DSF || '1',
};
// 独立性：**不**传 GPW_HOST_PID / DSH_PET_HOST_PID，副本就不会因为"宿主没了"而自杀
delete env.GPW_HOST_PID;
delete env.DSH_PET_HOST_PID;

const child = spawn(electron, [join(PACKAGE_ROOT, 'runtime', 'gpw-main.cjs')], {
  cwd: PACKAGE_ROOT,
  // 独立启动：stdout/stderr 不接给父进程（否则父进程一退、管道断开会触发 EPIPE 自杀路径）
  stdio: 'ignore',
  detached: true,
  env,
});
child.unref();
writeFileSync(PID_FILE, String(child.pid), 'utf8');
console.log(
  `副本已启动 pid=${child.pid}（Electron=${electron}，端口=${PORT}` +
    (PROFILE ? `，profile=${PROFILE}` : '，默认 profile') +
    (PET_NAME ? `，名字=${PET_NAME}` : '') + '）',
);
console.log(`  用户目录：${USER_ROOT}`);
console.log('  右键宠物 / 点状态胶囊 → 观察面板；鼠标扫过宠物 → 输入框；胶囊上的 📌 = 交互锁定。');
console.log('  它是独立进程：关掉 DSH 或关掉这个窗口都不影响它。停止用 --stop。');

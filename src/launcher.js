/**
 * 副本启动器：让插件负责"把桌宠窗拉起来"。
 *
 * 为什么放在插件里（而不是让你双击快捷方式）：你选的语义是"**DSH 开 → 宠物自己出现**"。
 * 插件活在 DSH 里，正好是那个"知道 DSH 已经开了"的角色。
 *
 * 关键细节：
 *   1. **detached + stdio:'ignore' + unref**：副本必须脱离 DSH 的进程树与管道。
 *      否则 DSH 一退出，它的 stdout 管道断开 → 副本走"宿主没了"的自杀路径（原版逻辑），
 *      或直接被 Job Object 带走。
 *   2. **传 DSH_PET_HOST_PID = DSH 宿主 pid**：副本据此跟随 DSH 退出（见下方 env 处的说明）。
 *      设计取舍：宠物必须跟着 DSH 一起退——没接入大脑的宠物没有价值，而且会占住端口
 *      让下次 DSH 启动时冲突。所以这里**不**追求"脱离 DSH 独立存活"。
 *   3. **锁文件 + 冷却**：探测失败可能是瞬时抖动；没有锁的话可能连开两个，
 *      第二个会 EADDRINUSE 然后自己退出（不致命，但会白闪一个窗口）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * 探测副本是否已经在跑：**直连 TCP，不走 HTTP 客户端**。
 *
 * 为什么不用 fetch：这台机器上设了 `NODE_USE_ENV_PROXY=1` + `HTTP_PROXY=127.0.0.1:7890`，
 * Node 的 fetch(undici) 会把 127.0.0.1 的请求也送去代理，而代理不转发回环 → 探针永远 false
 * （实测：curl 通、fetch 不通）。后果很严重：判成"没在跑"就会去开第二个副本，
 * 第二个 EADDRINUSE 闪退——白闪窗口、还可能顶掉正在跑的那个。
 * "进程在不在"这件事，一个 TCP 连接就是最准也最省的判据。
 */
export async function forkAlive(origin, timeoutMs = 1200) {
  let host = '127.0.0.1';
  let port = 7341;
  try {
    const url = new URL(origin);
    host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;
    port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  } catch {
    /* 用默认值 */
  }
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 拉起副本。
 * @param {{packageRoot:string, origin:string, upstreamRoot?:string, log?:(m:string)=>void}} options
 * @returns {Promise<{ok:boolean, pid?:number, message?:string}>}
 */
export async function launchFork(options) {
  const log = options.log ?? (() => {});
  /**
   * `options.profile` → 独立用户目录 ✓（多鱼 ✓）：
   *   默认 profile          → `~/.dsh/dsh-pet-gpw`
   *   `--profile second` 那种 → `~/.dsh/dsh-pet-gpw-second`
   * 否则插件保活只会去管**默认那一只** ✗ → 重启后其它鱼就"没人管"了 ✓
   * （主人报"为什么现在只启动了一只" ✓ 就是这个 ✓）。
   */
  const userRoot = join(
    homedir(),
    '.dsh',
    options.profile ? `dsh-pet-gpw-${String(options.profile).replace(/[^\w.-]+/g, '_')}` : 'dsh-pet-gpw',
  );
  const lockFile = join(userRoot, 'spawn.lock');
  const helperPidFile = join(userRoot, 'helper.pid');
  mkdirSync(userRoot, { recursive: true });

  // ---- 冷却：20 秒内只尝试一次（探测抖动不该连开多个）
  try {
    const raw = JSON.parse(readFileSync(lockFile, 'utf8'));
    if (raw?.at && Date.now() - raw.at < 20_000) {
      return { ok: false, message: `刚试过（${Math.round((Date.now() - raw.at) / 1000)}s 前），先等一会儿` };
    }
  } catch {
    /* 没有锁文件：正常路径 */
  }

  // ---- 已经在跑就别再开
  if (await forkAlive(options.origin)) return { ok: false, message: '副本已经在跑' };

  const electron = [
    process.env.GPW_ELECTRON,
    join(homedir(), '.dsh', 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  ].find((candidate) => candidate && existsSync(candidate));
  if (!electron) return { ok: false, message: '找不到 Electron（~/.dsh/electron/electron.exe）' };

  const main = join(options.packageRoot, 'runtime', 'gpw-main.cjs');
  // options.hostPid：DSH 宿主的 pid（插件侧传 process.pid）。缺省用本进程 pid（等价于"跟随调用者"）。
  if (!existsSync(main)) return { ok: false, message: '缺副本入口：' + main };

  /**
   * 原版素材目录：调用方（插件）通常会传；没传就按"当前 profile"推，**不写死用户名/路径**。
   * 写死的后果：换机器后第一次安装，这里永远指向 `C:\Users\Kishin\...`，
   * 保活只会一直报"找不到原版 dsh-pet 素材目录"，而用户根本不知道要去哪改。
   */
  const upstream =
    options.upstreamRoot ||
    [
      join(homedir(), '.dsh', 'profiles', String(process.env.DSH_PROFILE || 'desktop'), 'node_modules', 'dsh-pet'),
      join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-pet'),
    ].find((candidate) => existsSync(join(candidate, 'package.json'))) ||
    join(homedir(), '.dsh', 'profiles', String(process.env.DSH_PROFILE || 'desktop'), 'node_modules', 'dsh-pet');
  if (!existsSync(upstream)) return { ok: false, message: '找不到原版 dsh-pet 素材目录：' + upstream };

  const env = { ...process.env };
  // ELECTRON_RUN_AS_NODE 会让 Electron 以纯 Node 模式启动（没有 electron 模块）——必须清掉
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    GPW_UPSTREAM_ROOT: upstream,
    GPW_USER_ROOT: userRoot,
    /** 鱼板网络协议 v2 的身份字段 ✓（握手时回给对等体 ✓；空 = 老行为 ✓） */
    /** 共享图库目录（图片只有一份 ✓ 每条鱼的副本都要能取到 ✓） */
    GPW_SHARED_MEMES: String(options.sharedMemes ?? ''),
    GPW_FISH_SCOPE: String(options.scope ?? ''),
    GPW_FISH_ID: String(options.fishId ?? options.petId ?? ''),
    GPW_PORT: String(new URL(options.origin).port || '7341'),
    GPW_PLUGIN_ORIGIN: options.pluginOrigin ?? options.origin,
    DSH_PET_FORCE_DSF: '1',
    /**
     * 【退出耦合】把 DSH 宿主的 pid 交给副本，让它**跟随 DSH 退出**。
     *
     * 原理：副本用的原版助手代码里有 host-liveness 探测（`hostIsGone(pid)`，见
     * electron-helper-copy/host-liveness.js）：每隔一段时间 `kill(pid, 0)` 探一下宿主进程，
     * 收到 ESRCH（进程不存在）就主动退出。这是 OS 级事实，**不依赖任何心跳或 IPC** ——
     * 所以即使 DSH 是崩溃退出的（没机会执行清理代码），副本照样会发现并退出。
     *
     * 为什么必须有这条：没接入大脑的宠物没有价值，留着还会占住 7341 端口，
     * 导致下次 DSH 启动时"副本已在跑"或端口冲突（实战踩过 EADDRINUSE）。
     */
    DSH_PET_HOST_PID: String(options.hostPid ?? process.pid),
  });

  try {
    writeFileSync(lockFile, JSON.stringify({ at: Date.now(), by: process.pid }), 'utf8');
  } catch {
    /* 锁写不了也不阻塞启动 */
  }

  // 排障用：设 GPW_DEBUG_PORT=9222 让自动拉起的副本也开 DevTools 调试口
  // （默认不带——调试口会把 Electron 的启动参数暴露给任何本机进程，日常没必要开）
  const debugArgs = process.env.GPW_DEBUG_PORT ? [`--remote-debugging-port=${process.env.GPW_DEBUG_PORT}`] : [];
  const child = spawn(electron, [main, ...debugArgs], {
    cwd: options.packageRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();
  try {
    writeFileSync(helperPidFile, String(child.pid), 'utf8');
  } catch {
    /* 记录 pid 失败可忽略 */
  }
  log(`已拉起桌宠副本 pid=${child.pid}（Electron=${electron}）`);
  return { ok: true, pid: child.pid };
}

/**
 * 停掉副本（按 helper.pid）。
 *
 * ⚠️ 必须**按 profile** 找 pid 文件：多鱼之后每条鱼有自己的用户目录
 * （默认 → `~/.dsh/dsh-pet-gpw`；`--profile second` → `~/.dsh/dsh-pet-gpw-second`）。
 * 只按默认目录找的话，关掉 7342 会去杀 7341 的进程 ✗（或者什么都杀不到 ✗）。
 */
export function stopFork(log = () => {}, profile = '') {
  const userRoot = join(
    homedir(),
    '.dsh',
    profile ? `dsh-pet-gpw-${String(profile).replace(/[^\w.-]+/g, '_')}` : 'dsh-pet-gpw',
  );
  const helperPidFile = join(userRoot, 'helper.pid');
  if (!existsSync(helperPidFile)) return false;
  const pid = Number(readFileSync(helperPidFile, 'utf8').trim());
  try {
    process.kill(pid);
    log('已请求退出副本 pid=' + pid);
    rmSync(helperPidFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

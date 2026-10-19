/**
 * GoH 采集器的生命周期管理（`goh_logwatch.py`）。
 *
 * 背景（用户要求）：以前要**手动**起采集器，忘了起就会出现"插件读不到任何事件"——
 * 你开着游戏、插件也开了游戏情况，但事件文件一动不动。现在改成：
 * **面板里把「游戏情况」选成 `goh` → 采集器自动起来；选成空 → 自动停。**
 *
 * 设计取舍：
 *   - **不重复起**：采集器自己有 pid 单实例锁（`goh_logwatch.pid`），所以就算用户手动起过、
 *     我们又起一个，第二个会打印"已经有一个在跑"并 exit 3 —— 我们认这个退出码，
 *     只记一条日志、然后长时间退避，绝不反复拉起或者去杀别人的进程。
 *   - **只停自己起的**：`stop()` 只杀我们 spawn 出来的那个 pid；用户手动起的，我们不动。
 *   - **输出接进插件日志**：采集器的 stdout/stderr 逐行转发（前缀 `[采集器]`），
 *     这样"它在不在读、心跳怎么说"在插件日志里直接能看到，不用另开窗口。
 *   - Windows 上杀进程树用 `taskkill /T /F`（python 有时会有子进程）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 采集器被"别人已经在跑"挡住时的退出码（见 goh_logwatch.py 的单实例锁） */
const EXIT_ALREADY_RUNNING = 3;

export function createCollector(options) {
  const log = options.log ?? (() => {});
  const script = options.script;
  const python = options.python || 'python';
  const cwd = options.cwd || (script ? dirname(script) : process.cwd());
  const args = Array.isArray(options.args) && options.args.length ? options.args : ['--follow'];
  const outFile = options.outFile || join(cwd, 'events.jsonl');
  const pidFile = options.pidFile || join(cwd, 'goh_logwatch.pid');

  let child = null;
  let startedAt = null;
  let restarts = 0;
  let lastExit = null;
  let lastLine = '';
  let backoffMs = 5000;
  let nextTryAt = 0;
  let startedByUs = false;

  const alive = () => Boolean(child && child.exitCode === null && !child.killed);

  /** 读采集器自己写的 pid 文件（判断"是不是有别的实例在跑"） */
  function lockedPid() {
    try {
      if (!existsSync(pidFile)) return null;
      const raw = readFileSync(pidFile, 'utf8').trim();
      return /^\d+$/.test(raw) ? Number(raw) : null;
    } catch {
      return null;
    }
  }

  function handleLine(stream, line) {
    const text = String(line).trimEnd();
    if (!text) return;
    lastLine = text;
    // 采集器的心跳/事件走 stderr，正常事件预览走 stdout；都转进插件日志，标一下来源
    log(`[采集器${stream}] ${text}`);
  }

  function attach(proc) {
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    let bufOut = '';
    let bufErr = '';
    proc.stdout?.on('data', (chunk) => {
      bufOut += chunk;
      const lines = bufOut.split('\n');
      bufOut = lines.pop() ?? '';
      lines.forEach((l) => handleLine('', l));
    });
    proc.stderr?.on('data', (chunk) => {
      bufErr += chunk;
      const lines = bufErr.split('\n');
      bufErr = lines.pop() ?? '';
      lines.forEach((l) => handleLine('!', l));
    });
    proc.on('error', (error) => {
      log(`[采集器] 启动失败：${error?.message ?? error}`);
      lastExit = { code: null, error: String(error?.message ?? error) };
    });
    proc.on('exit', (code, signal) => {
      lastExit = { code, signal, at: Date.now() };
      const wasOurs = startedByUs;
      child = null;
      startedByUs = false;
      if (code === EXIT_ALREADY_RUNNING) {
        // 别人（多半是用户手动起的）已经在跑：长时间退避，绝不抢
        backoffMs = 60_000;
        nextTryAt = Date.now() + backoffMs;
        log(`[采集器] 已有别的实例在跑（pid=${lockedPid() ?? '?'}），本插件不重复启动`);
        return;
      }
      if (!wasOurs) return;
      restarts += 1;
      nextTryAt = Date.now() + backoffMs;
      log(`[采集器] 退出了（code=${code ?? signal ?? '?'}），${Math.round(backoffMs / 1000)}s 后重试（第 ${restarts} 次）`);
      backoffMs = Math.min(backoffMs * 2, 60_000); // 退避：5s→10s→20s→40s→60s
    });
  }

  /** 起一个（已有活着的就不起） */
  function start(reason = '') {
    if (alive()) return true;
    if (!script || !existsSync(script)) {
      log(`[采集器] 找不到脚本，没法自动启动：${script ?? '(未配置)'}`);
      return false;
    }
    try {
      child = spawn(python, [script, ...args], {
        cwd,
        env: {
          ...process.env,
          // 这台机器控制台默认 GBK，采集器 print 中文会 UnicodeEncodeError 直接退出（已踩过）
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      startedByUs = true;
      startedAt = Date.now();
      backoffMs = 5000;
      attach(child);
      log(`[采集器] 已启动${reason ? '（' + reason + '）' : ''}：${python} ${script} ${args.join(' ')}`);
      return true;
    } catch (error) {
      log(`[采集器] 启动异常：${error?.message ?? error}`);
      child = null;
      startedByUs = false;
      return false;
    }
  }

  /** 停掉**我们起的**那个（用户手动起的不动） */
  function stop(reason = '') {
    if (!alive()) return false;
    const pid = child.pid;
    try {
      if (process.platform === 'win32') {
        // python 可能有子进程；/T 连树一起收
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
      log(`[采集器] 已停止${reason ? '（' + reason + '）' : ''}：pid=${pid}`);
    } catch (error) {
      log(`[采集器] 停止失败：${error?.message ?? error}`);
    }
    startedByUs = false;
    return true;
  }

  return {
    /**
     * 让采集器的运行状态与"该不该跑"保持一致（幂等，可以每 15 秒调一次）。
     * @param {boolean} want 该不该跑（= 游戏情况选了 goh 且开关打开）
     */
    sync(want) {
      if (!want) {
        if (alive()) stop('游戏情况已关闭');
        return { running: false, action: 'off' };
      }
      if (alive()) return { running: true, action: 'keep' };
      if (Date.now() < nextTryAt) return { running: false, action: 'wait' };
      const ok = start('游戏情况 = goh');
      return { running: ok, action: ok ? 'start' : 'fail' };
    },
    start,
    stop,
    alive,
    status() {
      return {
        wanted: Boolean(options.isWanted?.()),
        running: alive(),
        pid: child?.pid ?? null,
        startedAt,
        restarts,
        lastExit,
        lastLine: lastLine.slice(0, 120),
        script: script ?? '',
        outFile,
        pidFile,
        lockedByOther: alive() ? null : lockedPid(),
      };
    },
  };
}

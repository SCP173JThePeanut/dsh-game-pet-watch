/**
 * **沙盒：两只鱼 + 跨进程碰撞注入**（专门测"对家能不能进站场"）
 *
 *   node scripts/sandbox-collide.mjs           # 跑完自动清理
 *   node scripts/sandbox-collide.mjs --keep    # 保留临时目录看现场
 *
 * 为什么单独一个沙盒：第一版 `sandbox-first-run` 只验证"一只鱼能起来、能报坐标"，
 * 而"对家进站场"是另一条链路（宠物进程定时拉插件的 `/rects` → 喂进渲染端站场）。
 * 这条链路坏掉时，界面上看起来只是"两只鱼叠在一起不动、也不撞"，很容易被当成动画问题。
 *
 * 断言：
 *   1. 两只鱼都起来、都上报真身盒；
 *   2. **两只鱼的站场里都出现对家**（collide-state.json 有两个 id）；
 *   3. 站场里的对家坐标/尺寸来自插件账本（≈上报值），不是窗口 DIP 换算出来的。
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PET_REPO = process.env.GPW_SANDBOX_PET_REPO || join(dirname(ROOT), 'dsh-pet-gpw');
const KEEP = process.argv.includes('--keep');
const TEMP = join(tmpdir(), `gpw-collide-${Date.now()}`);
const HOME_DIR = join(TEMP, '.dsh');
const ELECTRON = join(homedir(), '.dsh', 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron');

const FISH = [
  { id: 'a', port: 7391, user: join(TEMP, 'pet-a') },
  { id: 'b', port: 7392, user: join(TEMP, 'pet-b') },
];
/**
 * 只登记、不起进程的"第三只鱼"：用来测"静止重叠也要触发碰撞"。
 * 两只真鱼一启动就叠在同一个角落，它们的接触边沿在启动时就用掉了；
 * 用第三只（原点是个死端口，推送失败会被 try/catch 吃掉）才能干净地测一次"新接触"。
 */
const GHOST = { id: 'c', port: 7393, user: join(TEMP, 'pet-c') };

let pass = 0;
const fails = [];
const ok = (cond, label, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}${extra ? '  ' + extra : ''}`);
  } else {
    fails.push(label + (extra ? ' → ' + extra : ''));
    console.log(`  ❌ ${label}${extra ? '  → ' + extra : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (url, timeoutMs = 2500) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
};

const procs = [];
let server;
const cleanup = () => {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* 靠 DSH_PET_HOST_PID 自己退 */
    }
  }
  try {
    server?.close();
  } catch {
    /* 忽略 */
  }
  if (!KEEP) {
    try {
      rmSync(TEMP, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  } else {
    console.log('\n临时目录保留在：' + TEMP);
  }
};

try {
  console.log('=== 0. 沙盒环境 ===');
  mkdirSync(HOME_DIR, { recursive: true });
  for (const f of FISH) mkdirSync(f.user, { recursive: true });
  process.env.DSH_HOME = HOME_DIR;
  delete process.env.GPW_UPSTREAM_ROOT;
  console.log('  DSH_HOME = ' + HOME_DIR);

  const plugin = await import(pathToFileURL(join(ROOT, 'index.js')).href);
  const registered = [];
  /** 插件日志（沙盒里只用来断言"碰撞事件发生了没有"） */
  const pluginLogs = [];
  const stub = {
    logger: {
      info: (m) => pluginLogs.push(String(m)),
      warn: (m) => pluginLogs.push(String(m)),
      error: (m) => pluginLogs.push(String(m)),
      debug: () => {},
    },
    effect: (fn) => {
      const d = fn();
      return typeof d === 'function' ? d : () => {};
    },
    on: () => {},
    inject: () => {},
    webServer: { register: (spec) => (registered.push(spec), { dispose: () => {} }) },
    llm: { stream: async () => ({}) },
    attachments: { saveImage: async () => ({}) },
  };
  const ctx = new Proxy(stub, { get: (t, p) => (p in t ? t[p] : () => {}) });

  plugin.apply(ctx, {
    enabled: false, // 不用模型，只测"对家进站场"这条链路
    autoLaunchFork: false, // 自己起宠物，方便控制端口
    pets: FISH.map((f) => ({ id: f.id, name: '鱼' + f.id, origin: `http://127.0.0.1:${f.port}`, scope: f.id, enabled: true, qq: false })),
  });

  const route = registered.find((r) => r.path === '/game-pet-watch');
  ok(!!route, '插件注册了 /game-pet-watch');
  server = http.createServer((req, res) => void route.handler(req, res));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log('  沙盒插件地址 = ' + origin);

  console.log('=== 1. 起两只宠物 ===');
  for (const f of FISH) {
    const outFd = openSync(join(TEMP, `pet-${f.id}.out`), 'w');
    const errFd = openSync(join(TEMP, `pet-${f.id}.err`), 'w');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'GPW_UPSTREAM_ROOT') delete env[k];
    Object.assign(env, {
      GPW_PORT: String(f.port),
      GPW_USER_ROOT: f.user,
      GPW_PET_ID: f.id,
      GPW_FISH_ID: f.id,
      GPW_PLUGIN_ORIGIN: origin,
      DSH_PET_HOST_PID: String(process.pid),
      DSH_PET_FORCE_DSF: '1',
    });
    procs.push(
      spawn(ELECTRON, [join(PET_REPO, 'runtime', 'gpw-main.cjs')], {
        cwd: PET_REPO,
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
        env,
      }),
    );
    console.log(`  起 ${f.id} → 端口 ${f.port}，用户目录 ${f.user}`);
  }

  console.log('=== 2. 两只都在账本里（真身盒）===');
  let rects = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(500);
    const r = await getJson(origin + '/game-pet-watch/rects');
    const body = JSON.parse(r.body || '{}');
    const ids = Object.keys(body.rects || {});
    if (ids.length >= 2) {
      rects = body.rects;
      break;
    }
  }
  ok(!!rects, '两只鱼都上报了坐标', rects ? Object.keys(rects).join(',') : '40 秒内没凑齐');
  for (const f of FISH) {
    const r = rects?.[f.id];
    ok(!!r && r.w > 100, `${f.id} 的真身盒有宽度`, r ? `w=${r.w} x=${Math.round(r.x)}` : '缺失');
  }

  console.log('=== 3. 站场里要出现对家（这条是核心）===');
  const readStation = (f) => {
    const p = join(f.user, 'collide-state.json');
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  };
  let stations = {};
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    stations = Object.fromEntries(FISH.map((f) => [f.id, readStation(f)]));
    const good = FISH.every((f) => {
      const st = stations[f.id]?.states || {};
      return Object.keys(st).length >= 2;
    });
    if (good) break;
  }
  for (const f of FISH) {
    const st = stations[f.id]?.states || {};
    const other = FISH.find((x) => x.id !== f.id).id;
    ok(f.id in st, `${f.id} 站在自己站场里`);
    ok(other in st, `${f.id} 的站场里有对家 ${other}`, `实际: ${Object.keys(st).join(',') || '空'}`);
    const peer = st[other];
    if (peer) {
      // 对家的坐标必须和插件账本一致（±2px），否则就是又拿窗口 DIP 换算了
      const ledger = rects?.[other];
      /**
       * 只比「尺寸」和「同一个数量级」：碰撞一发生宠物就在被推开，
       * 站场快照和账本快照之间天然差几十上百像素（这不是 bug）。真正的信号是
       * **size 必须等于账本的 w**（693 = 462×1.5）—— 若被 DIP 换算过就会是 462。
       */
      const same = ledger ? Math.abs(peer.size - ledger.w) <= 2 && Math.abs(peer.x - ledger.x) <= 250 : false;
      ok(same, `${f.id} 站场里的对家坐标与账本一致（物理像素）`, ledger ? `站场 x=${Math.round(peer.x)} size=${peer.size} / 账本 x=${Math.round(ledger.x)} w=${ledger.w}` : '');
    }
  }

  /**
   * 3.6 **静止叠在一起也要算碰撞**（2026-10-18 改的边沿触发）。
   *
   * 旧逻辑要求"至少一方速度 > 30px/s"，主人把两只鱼拖到一起松手后两只都静止 →
   * 永远不触发（"碰撞没反应"的根因）。这里直接把 b 的包围盒按到 a 身上（速度 0），
   * 断言插件在几秒内报出一次"宠物碰撞"（同一段接触只报一次，不刷屏）。
   */
  console.log('=== 3.6 静止重叠也要触发一次碰撞 ===');
  {
    const before = pluginLogs.filter((l) => l.includes('宠物碰撞')).length;
    const ra = rects?.[FISH[0].id] || { x: 800, y: 900, w: 693, h: 390 };
    const overlapRect = { x: ra.x + 20, y: ra.y, w: 693, h: 390, vx: 0, vy: 0 };
    let fired = false;
    for (let i = 0; i < 30 && !fired; i += 1) {
      // 第三只鱼（没有进程，只能由我们代它上报）：速度 0，纯静止重叠
      await fetch(origin + '/game-pet-watch/rects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fishId: GHOST.id, port: GHOST.port, rect: overlapRect }),
      }).catch(() => {});
      await sleep(200);
      fired = pluginLogs.filter((l) => l.includes('宠物碰撞') && l.includes(GHOST.id)).length > 0;
    }
    ok(fired, '静止重叠触发了一次碰撞', fired ? '' : '5 秒内没有碰撞日志（闸门又回来了？）');
    const count = pluginLogs.filter((l) => l.includes('宠物碰撞')).length - before;
    ok(count <= 2, '同一次接触没刷屏', `新增 ${count} 条`);

  }

  /**
   * 3.5 **关掉一只鱼后，另一只的站场里要把它删掉**（2026-10-18 修的 bug：鱼关了碰撞体积还在）。
   *
   * 只增不删的话：对家进程没了 → 插件账本 5 秒后标 alive:false、60 秒后清掉 →
   * 但存活那只的 `petStates` 里那条永远留着 → 渲染端 `others` 里一直有幽灵 → 还会被撞。
   */
  console.log('=== 3.5 关掉一只鱼，另一只必须把它从站场里删掉 ===');
  const victim = FISH[1];
  const survivor = FISH[0];
  try {
    const pid = procs[1]?.pid;
    if (pid && process.platform === 'win32') execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    else procs[1]?.kill();
  } catch {
    /* 已经退了 */
  }
  console.log(`  已关掉 ${victim.id}（pid=${procs[1]?.pid}）`);

  // 先确认"账本里它确实不活了"（alive:false 或直接消失）——否则测的就不是删除逻辑，而是"没杀掉"
  let goneInLedger = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    const r = await getJson(origin + '/game-pet-watch/rects');
    const body = JSON.parse(r.body || '{}');
    const entry = (body.rects || {})[victim.id];
    if (!entry || entry.alive === false) {
      goneInLedger = true;
      break;
    }
  }
  ok(goneInLedger, `账本里 ${victim.id} 已经不算活着`, goneInLedger ? '' : '15 秒后仍 alive（进程可能没杀掉）');

  let dropped = false;
  let streak = 0;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const st = readStation(survivor)?.states || {};
    if (process.env.GPW_TRACE && i % 2 === 0) {
      const rr = await getJson(origin + '/game-pet-watch/rects');
      const led = JSON.parse(rr.body || '{}').rects || {};
      const e = led[victim.id];
      console.log(`    [trace ${i}] 账本有${victim.id}=${!!e} alive=${e ? e.alive : '-'} age=${e ? Date.now() - e.at : '-'}ms 站场=[${Object.keys(st).join(',')}]`);
    }
    if (!(victim.id in st)) {
      streak += 1;
      if (streak >= 3) {
        dropped = true;
        break;
      }
    } else {
      streak = 0; // 又出现了 = 还没真删掉（可能被重新注入），重头数
    }
  }
  const after = readStation(survivor)?.states || {};
  ok(dropped, `${survivor.id} 的站场里已经删掉了 ${victim.id}`, `实际: ${Object.keys(after).join(',') || '空'}`);
  ok(survivor.id in after, `${survivor.id} 自己还在站场里`);
} catch (error) {
  fails.push('未捕获异常：' + (error?.stack ?? error?.message ?? String(error)));
} finally {
  cleanup();
}

console.log(`\nsandbox-collide: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL ' + f);
process.exit(fails.length ? 1 : 0);

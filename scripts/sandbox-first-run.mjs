/**
 * **沙盒：模拟"第一次安装 + 资源自带 + 只有一只宠物 + 默认提示词"**
 *
 *   node scripts/sandbox-first-run.mjs          # 跑完自动清理
 *   node scripts/sandbox-first-run.mjs --keep   # 保留临时目录看现场
 *
 * 它做的事：
 *   1. 全新 `DSH_HOME`（临时目录，没有任何历史配置/记忆/鱼表）；
 *   2. 在本进程里加载插件 → `apply()` → 自己起一个 HTTP 服务承载路由；
 *   3. **真的拉起一个桌面宠物**（Electron，用仓库里那份运行时）：
 *      端口用 7397、用户目录在临时目录里、**不传 `GPW_UPSTREAM_ROOT`**
 *      —— 也就是让它自己去找素材。资源没独立时它会报"找不到原版 dsh-pet 包目录"直接退出；
 *      现在素材在仓库里，它应该能起来并回报坐标；
 *   4. 断言：/state 能开、鱼表为空但**只驱动一只**、默认人设/规则、登记簿有那唯一一只、
 *      宠物自报 `pluginOrigin`、`/rects` 收到它的真身盒；
 *   5. 杀掉宠物、关服务、清临时目录（`--keep` 则不删）。
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** 桌宠本体在**另一个仓库**（与本插件并排）：素材、运行时都在那边 */
const PET_REPO = process.env.GPW_SANDBOX_PET_REPO || join(dirname(ROOT), 'dsh-pet-gpw');
const KEEP = process.argv.includes('--keep');
const STAMP = Date.now();
const TEMP = join(tmpdir(), `gpw-sandbox-${STAMP}`);
const HOME_DIR = join(TEMP, '.dsh');
const PET_ROOT = join(TEMP, 'pet');
const PET_PORT = 7397;
const ELECTRON = join(homedir(), '.dsh', 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron');

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

async function getJson(url, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

let server;
let pet;
const cleanup = () => {
  try {
    if (pet && !pet.killed) pet.kill();
  } catch {
    /* 杀不掉就算了：DSH_PET_HOST_PID 是本进程，进程退出后它自己会走 */
  }
  try {
    server?.close();
  } catch {
    /* 同上 */
  }
  if (!KEEP) {
    try {
      rmSync(TEMP, { recursive: true, force: true });
    } catch {
      /* 删不掉留个路径 */
    }
  } else {
    console.log('\n临时目录保留在：' + TEMP);
  }
};

try {
  console.log('=== 0. 沙盒环境 ===');
  mkdirSync(HOME_DIR, { recursive: true });
  mkdirSync(PET_ROOT, { recursive: true });
  process.env.DSH_HOME = HOME_DIR;
  delete process.env.DSH_PROFILE_DIR;
  ok(!existsSync(join(HOME_DIR, 'game-pet-watch')), '全新环境（没有任何历史配置）');

  /**
   * 预置一小份记忆：一条普通的（主人）+ 一条 `role:'system'`（游戏事件原文）。
   * 用来验"记录页默认不显示系统条目，但记忆里确实有"（`historyHideSystem`）。
   */
  {
    const dir = join(HOME_DIR, 'game-pet-watch');
    mkdirSync(dir, { recursive: true });
    const base = Date.now();
    writeFileSync(
      join(dir, 'memory.json'),
      JSON.stringify({
        entries: [
          { at: base - 2000, role: 'me', kind: 'reply', text: '沙盒：主人说的一句话' },
          { at: base - 1000, role: 'system', kind: 'game-event', text: '沙盒：短时间内连续 3 次击杀' },
          { at: base, role: 'pet', kind: 'reply', text: '沙盒：宠物回的一句话' },
        ],
        longTerm: { text: '', at: 0 },
        notes: [],
      }),
      'utf8',
    );
  }
  delete process.env.GPW_UPSTREAM_ROOT;
  delete process.env.GPW_PLUGIN_ORIGIN;
  delete process.env.GPW_USER_ROOT;
  console.log('  DSH_HOME = ' + HOME_DIR);
  console.log('  宠物用户目录 = ' + PET_ROOT);

  console.log('=== 1. 素材是否已独立（仓库自带）===');
  const assetsCfg = join(PET_REPO, 'assets', 'config.jsonc');
  ok(existsSync(assetsCfg), '仓库自带 assets/config.jsonc');
  const webmDir = join(PET_REPO, 'assets', 'webm');
  const webmCount = existsSync(webmDir) ? readdirSync(webmDir).length : 0;
  ok(webmCount > 3, '仓库自带 webm 动画', `${webmCount} 个`);

  console.log('=== 2. 插件（全新 HOME，只有默认那一只）===');
  const plugin = await import(pathToFileURL(join(ROOT, 'index.js')).href);
  const registered = [];
  const disposers = [];
  const stub = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    effect: (fn) => {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return () => {};
    },
    on: () => {},
    inject: () => {},
    webServer: { register: (spec) => (registered.push(spec), { dispose: () => {} }) },
    llm: { stream: async () => ({}) },
    attachments: { saveImage: async () => ({ id: 'sandbox' }) },
  };
  const ctx = new Proxy(stub, {
    get: (t, p) => (p in t ? t[p] : () => {}),
  });
  plugin.apply(ctx, { enabled: false, autoLaunchFork: false, pushToPet: false });
  const route = registered.find((r) => r.path === '/game-pet-watch');
  ok(!!route, '插件注册了 /game-pet-watch');

  server = http.createServer((req, res) => void route.handler(req, res));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const sandboxOrigin = `http://127.0.0.1:${server.address().port}`;
  console.log('  沙盒插件地址 = ' + sandboxOrigin);

  const state = JSON.parse((await getJson(sandboxOrigin + '/game-pet-watch/state')).body);
  ok(state?.ok === true, 'GET /state 200');
  ok((state?.config?.pets ?? []).length === 0, '鱼表为空（第一次安装）');
  ok(
    state?.prompt?.personality === plugin.DEFAULTS.personality && state?.prompt?.rules === plugin.DEFAULTS.rules,
    '提示词用默认值（没写自定义人设）',
    `personality=${String(state?.prompt?.personality ?? '').slice(0, 24)}…`,
  );

  /** 记录页/面板读的两条接口：默认都**不返回** `role:'system'` 的条目，但记忆里确实有 */
  const memHidden = JSON.parse((await getJson(sandboxOrigin + '/game-pet-watch/memory?limit=40')).body);
  ok(Array.isArray(memHidden?.entries) && memHidden.entries.length === 2, 'GET /memory 默认只返回非系统条目', `entries=${memHidden?.entries?.length}`);
  ok((memHidden?.entries ?? []).every((e) => e.role !== 'system'), '记录页接口里没有 role=system');
  const stateHidden = state?.memory?.last ?? [];
  ok(stateHidden.every((e) => e.role !== 'system'), '/state.memory.last 也没有 role=system');
  await new Promise((r) => setTimeout(r, 120));
  await fetch(sandboxOrigin + '/game-pet-watch/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { historyHideSystem: false } }),
  });
  const memShown = JSON.parse((await getJson(sandboxOrigin + '/game-pet-watch/memory?limit=40')).body);
  ok((memShown?.entries ?? []).some((e) => e.role === 'system'), '关掉开关后系统条目会显示出来');
  await fetch(sandboxOrigin + '/game-pet-watch/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { historyHideSystem: true } }),
  });
  ok(String(state?.prompt?.personality ?? '').length > 10, '默认人设非空（第一次安装也有提示词）');

  // 登记簿：即使鱼表为空，也应该登记"实际会驱动的那一只"
  const regFile = join(HOME_DIR, 'fish-board', 'registry.json');
  ok(existsSync(regFile), '公共登记簿已生成');
  const reg = existsSync(regFile) ? JSON.parse(readFileSync(regFile, 'utf8')) : { fish: [] };
  ok(reg.fish.length === 1, '登记簿里正好一只（默认那只）', `fish=${reg.fish.map((f) => f.id).join(',')}`);
  ok(reg.fish[0]?.origin?.includes('7341'), '默认那只指向默认端口', String(reg.fish[0]?.origin));

  console.log('=== 3. 真的拉起一只桌面宠物（不带 GPW_UPSTREAM_ROOT）===');
  ok(existsSync(ELECTRON), '找到 Electron 可执行文件', ELECTRON);
  const petOut = join(TEMP, 'pet.out');
  const petErr = join(TEMP, 'pet.err');
  const outFd = openSync(petOut, 'w');
  const errFd = openSync(petErr, 'w');
  /**
   * 环境要照 launcher 的规矩来：**必须删掉 `ELECTRON_RUN_AS_NODE`** ——
   * 带着它，electron.exe 会当纯 Node 跑（没有 electron 模块），gpw-main 一 require 就退出。
   * 这正是"宠物起不来"最常见的原因，launcher 里为此专门有一行 delete。
   */
  const petEnv = { ...process.env };
  delete petEnv.ELECTRON_RUN_AS_NODE;
  Object.assign(petEnv, {
    GPW_PORT: String(PET_PORT),
    GPW_USER_ROOT: PET_ROOT,
    GPW_PET_ID: 'gpw',
    GPW_FISH_ID: 'first',
    GPW_PLUGIN_ORIGIN: sandboxOrigin,
    DSH_PET_HOST_PID: String(process.pid),
    DSH_PET_FORCE_DSF: '1',
    // 故意的：不设 GPW_UPSTREAM_ROOT，看它能不能用仓库自带的素材
  });
  for (const key of Object.keys(petEnv)) if (key.toUpperCase() === 'GPW_UPSTREAM_ROOT') delete petEnv[key];
  pet = spawn(ELECTRON, [join(PET_REPO, 'runtime', 'gpw-main.cjs')], {
    cwd: PET_REPO,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
    env: petEnv,
  });
  pet.once('exit', (code) => console.log(`  （宠物进程已退出 code=${code}）`));
  console.log('  宠物 pid = ' + pet.pid);

  let brand = null;
  for (let i = 0; i < 60 && !brand; i += 1) {
    await sleep(500);
    try {
      const r = await getJson(`http://127.0.0.1:${PET_PORT}/gpw/brand`, 1500);
      if (r.status === 200) brand = JSON.parse(r.body);
    } catch {
      /* 还没起来 */
    }
  }
  ok(!!brand, '宠物起来了（能应答 /gpw/brand）', brand ? `pid=${brand.pid}` : '30 秒内没起来');
  if (!brand) {
    // 起不来时把宠物自己的输出打出来（这是沙盒存在的意义：看现场）
    for (const [label, file] of [['stderr', petErr], ['stdout', petOut]]) {
      try {
        const text = readFileSync(file, 'utf8').trim();
        if (text) console.log(`  --- 宠物 ${label} ---\n` + text.split(/\r?\n/).slice(-12).join('\n'));
      } catch {
        /* 没日志 */
      }
    }
  }
  try {
    closeSync(outFd);
    closeSync(errFd);
  } catch {
    /* 已关 */
  }
  ok(brand?.fishId === 'first', '宠物自报身份', String(brand?.fishId));
  ok(brand?.pluginOrigin === sandboxOrigin, '宠物自报沙盒插件地址', String(brand?.pluginOrigin));

  console.log('=== 4. 宠物上报坐标（跨进程链路）===');
  let rects = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const r = await getJson(sandboxOrigin + '/game-pet-watch/rects', 2000);
    const body = JSON.parse(r.body);
    if (body?.rects?.first?.w > 0) {
      rects = body.rects;
      break;
    }
  }
  ok(!!rects, '/rects 收到了这只宠物的坐标', rects ? JSON.stringify(rects.first) : '20 秒内没收到');
  ok(!rects || Object.keys(rects).length === 1, '账本里只有一只（没有幽灵）', rects ? Object.keys(rects).join(',') : '');

  // 收尾
  for (const d of disposers) {
    try {
      d();
    } catch {
      /* 忽略 */
    }
  }
} catch (error) {
  fails.push('未捕获异常：' + (error?.stack ?? error?.message ?? String(error)));
} finally {
  cleanup();
}

console.log(`\nsandbox-first-run: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL ' + f);
process.exit(fails.length ? 1 : 0);

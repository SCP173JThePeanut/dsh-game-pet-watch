/**
 * **第一次安装**的模拟测试（不碰现有环境，全在临时目录里跑）。
 *
 *   node tests/first-install.test.mjs
 *
 * 它模拟的是"一个从没见过这只插件的机器/用户"：
 *   1. 只按 `package.json` 的 `files` 把包"打"出来（= `npm pack` 会带走的东西）——
 *      少带了 `web/`、`src/`、`index-*.js` 这类文件，这一条就会红；
 *   2. 装进 `<temp>/node_modules/dsh-game-pet-watch`（真实安装的布局）；
 *   3. 用**全新**的 `DSH_HOME`/`USERPROFILE`，没有任何历史配置、记忆、日志、鱼表；
 *   4. import 装上后的入口 → 跑 `apply()` → 用假的 webServer 抓到路由，逐个真打一遍。
 *
 * 为什么值得单独一份：`exports.test.mjs` 只测纯函数，`preflight.mjs` 跑的是**仓库里**的代码、
 * 用的是**你本机**的 HOME（有历史配置）。"换个干净环境还起不来"这类问题只有这里能发现。
 */
import http from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let pass = 0;
const fails = [];
function ok(cond, label, extra = '') {
  if (cond) pass += 1;
  else fails.push(`${label}${extra ? '：' + extra : ''}`);
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
	ok(a === b, label, `got ${a} want ${b}`);
}

// .replace 去 BOM：文件本身不该有（2026-10-18 那次用 PowerShell 改版本号就种了一个，
// 结果 npm 能读、node 的 JSON.parse 不能 —— 测试当场抓到）
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
/**
 * 包源：默认是仓库本身；设 `GPW_INSTALL_SRC` 指向 `npm pack` 解出来的 `package/` 目录，
 * 就等于"验证**发布出去的那个包**能装上、能跑"（而不是验证仓库里能跑）。
 */
const SOURCE = (process.env.GPW_INSTALL_SRC || '').trim() || ROOT;
const TEMP = join(tmpdir(), `dsh-gpw-install-${Date.now()}`);
const INSTALL = join(TEMP, 'node_modules', 'dsh-game-pet-watch');
const HOME = join(TEMP, '.dsh');

const cleanup = () => {
  try {
    rmSync(TEMP, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉就留着 */
  }
};

try {
  // ── 1. 按 files 打出来（模拟 npm pack 的内容）─────────────────────────
  mkdirSync(INSTALL, { recursive: true });
  const packed = [];
  for (const entry of PKG.files ?? []) {
    if (entry.includes('*')) {
      // 形如 `index-*.js`
      const [pre, suf] = entry.split('*');
      const matches = readdirSync(SOURCE).filter((f) => f.startsWith(pre) && f.endsWith(suf));
      ok(matches.length > 0, `files 里的 ${entry} 有匹配文件`);
      for (const f of matches) {
        cpSync(join(SOURCE, f), join(INSTALL, f));
        packed.push(f);
      }
      continue;
    }
    const src = join(SOURCE, entry);
    ok(existsSync(src), `files 里的 ${entry} 存在`);
    if (!existsSync(src)) continue;
    cpSync(src, join(INSTALL, entry), { recursive: true });
    packed.push(entry);
  }
  cpSync(join(SOURCE, 'package.json'), join(INSTALL, 'package.json'));
  ok(packed.includes('web'), '打包内容含 web/（三个页面靠它，缺了 /history 等会 500）');
  ok(packed.includes('src'), '打包内容含 src/');
  for (const page of ['history.html', 'boxes.html', 'qq.html']) {
    ok(existsSync(join(INSTALL, 'web', page)), `打包内容含 web/${page}`);
  }

  // ── 2. 依赖：真实安装里 schemastery 是宿主 node_modules 里的（hoist），这里用 junction 模拟
  const realProfileModules = join(
    (process.env.USERPROFILE || process.env.HOME || '.'),
    '.dsh',
    'profiles',
    'desktop',
    'node_modules',
  );
  const schemastery = join(realProfileModules, '@deepseek-ai', 'schemastery');
  if (existsSync(schemastery)) {
    mkdirSync(join(INSTALL, 'node_modules', '@deepseek-ai'), { recursive: true });
    try {
      symlinkSync(schemastery, join(INSTALL, 'node_modules', '@deepseek-ai', 'schemastery'), 'junction');
    } catch {
      /* 建不了链接就让插件走"没有 schema"的降级路径，后面的断言会照样检查 */
    }
  }

  // ── 3. 全新 HOME ─────────────────────────────────────────────────
  process.env.DSH_HOME = HOME;
  process.env.USERPROFILE = TEMP;
  delete process.env.DSH_WEB_ORIGIN;
  delete process.env.DSH_WEB_PORT;
  delete process.env.DSH_PROFILE;
  // 本机环境里可能带着真实 profile 的 DSH_PROFILE_DIR：不清掉就会读到主人的 patch（节奏/提示词全歪）
  delete process.env.DSH_PROFILE_DIR;

  // ── 4. import + apply（和宿主加载插件同一条路径）────────────────────
  const entry = await import(pathToFileURL(join(INSTALL, 'index.js')).href);
  ok(typeof entry.apply === 'function', '装上后的入口能 import 且导出 apply');
  ok(entry.Config !== undefined, 'schema 可用（依赖解析成功）', 'Config 是 undefined');
  eq(entry.DEFAULTS.upstreamPetRoot, '', '默认值里不含别人的绝对路径（upstreamPetRoot 留空，运行时推）');
  eq(entry.DEFAULTS.gpwRoot, '', '默认值里不含别人的绝对路径（gpwRoot 留空，运行时按兄弟仓库推）');
  // 推导函数本身也要能用：本机两个仓库并排，应该能找到 dsh-pet-gpw
  const derivedPetRoot = entry.resolveGpwRoot({ packageDir: ROOT, fsExists: (p) => existsSync(p) });
  ok(
    typeof derivedPetRoot === 'string' && derivedPetRoot.length > 0,
    'resolveGpwRoot 能推出一个仓库路径',
    String(derivedPetRoot),
  );
  ok(
    !/^[A-Z]:\//i.test(derivedPetRoot) || existsSync(join(derivedPetRoot, 'runtime', 'gpw-main.cjs')),
    'resolveGpwRoot 推出来的目录里确实有副本入口（或退化成候选路径）',
    derivedPetRoot,
  );

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
    webServer: {
      register: (spec) => {
        registered.push(spec);
        return { dispose: () => {} };
      },
    },
    llm: { stream: async () => ({}) },
    attachments: { saveImage: async () => ({ id: 'stub' }) },
  };
  const ctx = new Proxy(stub, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => {};
    },
  });
  const dispose = entry.apply(ctx, { enabled: false, autoLaunchFork: false, pushToPet: false });
  ok(true, '第一次安装：apply() 没有抛错');
  ok(registered.length > 0, '第一次安装：路由已注册');

  const route = registered.find((r) => r.path === '/game-pet-watch');
  ok(!!route, '注册了 /game-pet-watch 前缀路由');

  // ── 5. **独立起一个 HTTP 服务**，用真请求打一遍（不依赖 DSH、不依赖别的插件）──
  // 用 node:http 承载注册的 handler，等价于宿主做的事；端口用 0 让系统分配。
  const server = http.createServer((req, res) => {
    void route.handler(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  ok(port > 0, '插件可以独立监听一个端口（不依赖宿主）', String(port));

  const call = async (path, { method = 'GET', body = '' } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/game-pet-watch${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body || undefined,
    });
    return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
  };

  const state = await call('/state');
  ok(state.status === 200, 'GET /state 200', `status=${state.status}`);
  let stateJson = null;
  try {
    stateJson = JSON.parse(state.body);
  } catch {
    /* 下面会红 */
  }
  ok(stateJson && stateJson.ok === true, 'GET /state 返回 ok:true', state.body.slice(0, 120));
  ok(stateJson?.config?.intervalSec === 20, 'GET /state 带默认配置', 'intervalSec=' + stateJson?.config?.intervalSec);

  /**
   * **CORS**：宠物浮层跑在 `http://127.0.0.1:<宠物端口>`，要跨源读 `/state`。
   * 没有 `Access-Control-Allow-Origin` 时浏览器读不到响应 → 浮层永远显示"插件离线"
   * （curl 测不出来，所以这个坑藏了很久）。
   */
  ok(state.headers['access-control-allow-origin'] === '*', 'GET /state 带 CORS 头（浮层才读得到）', String(state.headers['access-control-allow-origin']));

  /** 每条鱼自己的观察状态：GET /fish 要有结构；POST 要能单独暂停某一条 */
  const fishList = await call('/fish');
  ok(fishList.status === 200, 'GET /fish 200', 'status=' + fishList.status);
  let fishJson = null;
  try { fishJson = JSON.parse(fishList.body); } catch { /* 下面会红 */ }
  ok(Array.isArray(fishJson?.fishes), 'GET /fish 返回 fishes 数组');
  ok(fishJson?.global && typeof fishJson.global.paused === 'boolean', 'GET /fish 带全局开关');
  const badFish = await call('/fish', { method: 'POST', body: JSON.stringify({ fish: 'nope', paused: true }) });
  ok(badFish.status === 404, 'POST /fish 未知鱼 → 404', 'status=' + badFish.status);
  const noFish = await call('/fish', { method: 'POST', body: JSON.stringify({ paused: true }) });
  ok(noFish.status === 400, 'POST /fish 缺 fish → 400', 'status=' + noFish.status);
  const preflight = await fetch(`http://127.0.0.1:${port}/game-pet-watch/ask`, {
    method: 'OPTIONS',
    headers: { origin: 'http://127.0.0.1:7341', 'access-control-request-method': 'POST' },
  });
  ok(preflight.status === 204, 'OPTIONS 预检返回 204', `status=${preflight.status}`);
  ok(
    preflight.headers.get('access-control-allow-methods')?.includes('POST') === true,
    'OPTIONS 预检允许 POST',
    String(preflight.headers.get('access-control-allow-methods')),
  );

  for (const [path, check] of [
    ['/config', (j) => j?.values?.intervalSec === 20],
    ['/pets', (j) => Array.isArray(j?.pets)],
    ['/rects', (j) => j && typeof j.rects === 'object'],
    ['/memory', (j) => Array.isArray(j?.entries)],
  ]) {
    const r = await call(path);
    ok(r.status === 200, `GET ${path} 200`, `status=${r.status}`);
    let parsed = null;
    try {
      parsed = JSON.parse(r.body);
    } catch {
      /* 下面红 */
    }
    ok(check(parsed), `GET ${path} 的形状对`, r.body.slice(0, 100));
  }

  for (const path of ['/history', '/boxes', '/qq']) {
    const r = await call(path);
    ok(r.status === 200, `GET ${path} 200`, `status=${r.status}`);
    ok(/<html/i.test(r.body), `GET ${path} 是 HTML（web/ 确实被装上了）`);
  }

  // 干净环境没有鱼表：/rects 必须"照收"，而不是把唯一那只鱼丢掉
  const rect = await call('/rects', {
    method: 'POST',
    body: JSON.stringify({ fishId: 'first', port: 7341, rect: { x: 1, y: 2, w: 540, h: 304 } }),
  });
  ok(rect.status === 200, 'POST /rects 200');
  let rectJson = null;
  try {
    rectJson = JSON.parse(rect.body);
  } catch {
    /* 下面红 */
  }
  ok(rectJson && rectJson.ok === true, '没有鱼表时 /rects 仍然收下盒子（单鱼默认行为）', rect.body.slice(0, 120));

  // ── 5b. **独立运作**：不依赖任何一款游戏 / 别的插件 ─────────────────
  // 事件源与机制库都选了 goh，但**路径是空的**（用户还没填）→ 必须照样跑，不许抛错。
  const registered2 = [];
  const ctx2 = new Proxy(
    { ...stub, webServer: { register: (spec) => (registered2.push(spec), { dispose: () => {} }) } },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => {};
      },
    },
  );
  const dispose2 = entry.apply(ctx2, {
    enabled: false,
    autoLaunchFork: false,
    gameSource: 'goh',
    databaseSource: 'goh',
  });
  ok(true, '独立运作：选了事件源/机制库但文件路径为空，apply() 仍不抛错');
  ok(registered2.length > 0, '独立运作：第二实例也注册了路由');
  if (typeof dispose2 === 'function') {
    try {
      dispose2();
    } catch {
      /* 忽略 */
    }
  }

  // 不许把某款游戏/某台机器的路径当默认值
  for (const key of ['gohFile', 'mechanicsFile', 'mechanicsQuickFile', 'gohCollectorScript']) {
    eq(entry.DEFAULTS[key], '', `默认值 ${key} 为空（内容路径由用户自己填）`);
  }
  ok(entry.DEFAULTS.petTarget === 'gpw', '默认投喂目标是副本（不依赖原版 dsh-pet 插件）');
  eq(entry.DEFAULTS.gameSource, '', '默认不绑定任何游戏事件源');
  eq(entry.DEFAULTS.databaseSource, '', '默认不绑定任何机制库');

  // ── 6. 第一次安装应该留下的东西 ──────────────────────────────────
  // 注：`config.json` 是"设置页/鱼表第一次变更"才写的（插件平时跑在 patch + 默认值上），
  // 所以这里只断言日志与登记簿 —— 它们才是每次启动都会落的观测物。
  ok(existsSync(join(HOME, 'game-pet-watch', 'plugin.log')), '插件日志已生成');
  const registryFile = join(HOME, 'fish-board', 'registry.json');
  ok(existsSync(registryFile), '公共登记簿已生成（~/.dsh/fish-board/registry.json）');
  if (existsSync(registryFile)) {
    const reg = JSON.parse(readFileSync(registryFile, 'utf8'));
    eq(reg.protocol, 'fish-board/3', '登记簿协议版本');
    ok(reg.pluginOrigin === '' || /^http:\/\//.test(reg.pluginOrigin), '登记簿里的插件地址为空或是合法 URL（不放猜测值）');
    // 第一次安装没有鱼表，但**实际会驱动一只**（默认那只）→ 登记簿要如实写这一只
    eq(reg.fish.length, 1, '登记簿里正好一只（默认那只，不编造多只）');
    eq(reg.fish[0]?.id, 'gpw', '默认那只的 id');
    eq(reg.fish[0]?.enabled, true, '默认那只是启用的');
    eq(reg.fish[0]?.port, 7341, '默认那只指向默认端口 7341');
  }

  // ── 7. 运行时文件里不许出现别人机器的绝对路径（注释里作为"历史教训"提到不算）──
  const codeOnly = (text) =>
    text
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim();
        return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      })
      .join('\n');
  const runtimeFiles = ['index.js', ...readdirSync(join(INSTALL, 'src')).filter((f) => f.endsWith('.js')).map((f) => join('src', f))];
  for (const rel of runtimeFiles) {
    const text = codeOnly(readFileSync(join(INSTALL, rel), 'utf8'));
    ok(!/C:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+/i.test(text), `${rel} 的代码里没有写死的用户目录`);
    ok(!/[A-Z]:[\\/]+goh agent/i.test(text), `${rel} 的代码里没有写死本机工作区路径（G:/goh agent/…）`);
  }

  // 收尾：先关心脏的句柄，再清理
  await new Promise((resolve) => server.close(resolve));
  if (typeof dispose === 'function') {
    try {
      dispose();
    } catch {
      /* 清理失败无所谓 */
    }
  }
  for (const d of disposers) {
    try {
      d();
    } catch {
      /* 同上 */
    }
  }
} catch (error) {
  fails.push('未捕获异常：' + (error?.stack ?? error?.message ?? String(error)));
} finally {
  cleanup();
}

console.log(`first-install.test: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL ' + f);
process.exit(fails.length ? 1 : 0);

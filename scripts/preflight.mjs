/**
 * 上线前自检（**重启 DSH 之前必须先跑这个**）。
 *
 * 为什么需要：DSH 插件在加载期抛错会让**宿主整个起不来**（"应用无法启动或已意外停止"）。
 * 我们已经因此崩过三次：
 *   ① 引用了别的模块里的常量名（PACKAGE_ROOT）→ ReferenceError；
 *   ② 写回配置时把 patch 文件写坏 → patch 解析失败；
 *   ③ apply() 里用了 ESM 不存在的 require。
 * 这个脚本把这些"加载期才会暴露"的错误在重启前抓出来。
 *
 *   node scripts/preflight.mjs
 *
 * 检查项：
 *   1. 所有入口与模块能 import（语法 + 顶层求值 + 依赖解析）
 *   2. DEFAULTS / parseDecision 等导出存在
 *   3. profile 的 cordis.patch.yml **能被 YAML 解析**（用 profile 自带的解析器）
 *   4. patch 里的入口文件存在
 *   5. package.json 的 bundles 含本插件，且 JSON 合法
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/**
 * 当前 profile 目录：从环境推，**不写死用户名**（否则这份自检换台机器就跑不了）。
 *   DSH_WEB_PROFILE_DIR  最明确（宿主若提供就用它）
 *   否则 `<DSH_HOME 或 ~/.dsh>/profiles/<DSH_PROFILE 或 desktop>`
 */
const DSH_HOME = (process.env.DSH_HOME || '').trim() || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
const PROFILE =
  (process.env.DSH_WEB_PROFILE_DIR || '').trim() ||
  join(DSH_HOME, 'profiles', (process.env.DSH_PROFILE || 'desktop').trim() || 'desktop');
const PATCH = join(PROFILE, 'cordis.patch.yml');

let failed = 0;
const ok = (name, extra = '') => console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`);
const bad = (name, why) => {
  console.log(`  ❌ ${name}  → ${why}`);
  failed += 1;
};

console.log('=== 1. 模块能否加载（语法 / 顶层求值 / 依赖解析）===');
const modules = [
  'index.js',
  'src/goh.js',
  'src/config-store.js',
  'src/launcher.js',
  'src/capture.js',
  'src/memory.js',
  'src/catalog.js',
];
for (const rel of modules) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) {
    bad(rel, '文件不存在');
    continue;
  }
  try {
    await import(pathToFileURL(file).href);
    ok(rel);
  } catch (error) {
    bad(rel, (error?.message ?? String(error)).split('\n')[0]);
  }
}

console.log('=== 2. 入口导出 ===');
try {
  const entry = await import(pathToFileURL(join(ROOT, 'index.js')).href);
  for (const key of ['apply', 'inject', 'DEFAULTS', 'normalizeConfig', 'parseDecision']) {
    if (typeof entry[key] === 'undefined') bad(`导出 ${key}`, '缺失');
    else ok(`导出 ${key}`);
  }
} catch (error) {
  bad('入口导出', (error?.message ?? String(error)).split('\n')[0]);
}

console.log('=== 2b. 真跑一次 apply()（抓初始化期错误）===');
/**
 * 为什么必须真调一次：只 import 模块只能发现**模块级**错误。
 * 初始化期的错误（变量 TDZ、顺序问题、ctx 用法不对）只在 apply() 执行时才暴露 ——
 * 「Cannot access 'state' before initialization」就是这么漏过去的：DSH 起得来、插件起不来、宠物消失。
 *
 * 副作用控制：传 enabled:false + autoLaunchFork:false（避免把副本拉起来），跑完调用清理函数。
 */
/**
 * ⚠️ **apply() 必须跑在临时 HOME 里**（变量声明在外层，`finally` 也要用）。
 *
 * 教训（2026-10-18 凌晨真踩到）：这个自检以前用的是**真实的** `DSH_HOME`，
 * 而 apply() 会写 `plugin.log`、会尝试启动事件采集器、还会经提示词守卫写 profile 的 patch。
 * 于是"跑一次自检"就污染了线上状态：日志里多出一堆 `enabled=false` 的初始化行，
 * 采集器报"找不到脚本"，最严重的一次直接让宿主里的插件行失联（要重启 DSH 才回来）。
 * 自检的意义是"检查"，不该有副作用 —— 所以这里把 HOME 换到临时目录，跑完再还原。
 */
const realHome = process.env.DSH_HOME;
const realProfile = process.env.USERPROFILE;
const tempHome = join(tmpdir(), `dsh-gpw-preflight-${Date.now()}`);
process.env.DSH_HOME = tempHome;
process.env.USERPROFILE = tempHome;

try {
  const entry = await import(pathToFileURL(join(ROOT, 'index.js')).href);
  const disposers = [];
  const touched = new Set();
  const stub = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    effect: (fn) => {
      try {
        const d = fn();
        if (typeof d === 'function') disposers.push(d);
      } catch (error) {
        console.log('  ⚠ effect 回调执行抛错：' + (error?.message ?? String(error)).split('\n')[0]);
        failed += 1;
      }
      return () => {};
    },
    on: () => {},
    inject: () => {},
    // 真实 ctx 提供 webServer.register（HTTP 路由注册在这上面）。假 ctx 缺了它，
    // 自检就会报"ctx.webServer.register is not a function"这种假故障。
    webServer: { register: () => ({ dispose: () => {} }) },
    // 插件通过它拿模型通道（只在使用时调用，init 期不该碰）
    llm: { stream: async () => ({}) },
    attachments: {
      saveImage: async () => {
        throw new Error('preflight：初始化期不应调用 attachments.saveImage');
      },
    },
  };
  const ctx = new Proxy(stub, {
    get(target, prop) {
      if (prop in target) return target[prop];
      touched.add(String(prop));
      return () => {}; // 未知成员一律当空函数，别让自检本身失败
    },
  });
  const dispose = entry.apply(ctx, { enabled: false, autoLaunchFork: false, gameSource: '' });
  ok('apply() 执行通过（全关配置）');

  /**
   * 再跑一遍**全开配置**（事件源 + 机制库都选 goh）。
   *
   * 为什么：只测全关配置会漏掉"启用路径"里的初始化错误 —— 而这正是我踩过的坑
   * （`databaseSource`/`gameSource` 的构建代码只在启用时才执行）。
   * 副作用仍然受控：autoLaunchFork=false、enabled=false（不会真去调模型/拉副本）。
   */
  const ctx2 = new Proxy({ ...stub }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      touched.add(String(prop));
      return () => {};
    },
  });
  const dispose2 = entry.apply(ctx2, {
    enabled: false,
    autoLaunchFork: false,
    gameSource: 'goh',
    databaseSource: 'goh',
  });
  ok('apply() 执行通过（事件源+机制库都开）');
  if (typeof dispose2 === 'function') {
    try {
      dispose2();
    } catch {
      /* 同上 */
    }
  }
  if (touched.size) console.log('     （用到的 ctx 成员：' + [...touched].join(', ') + '）');
  for (const d of disposers) {
    try {
      d();
    } catch {
      /* 清理失败无所谓 */
    }
  }
  if (typeof dispose === 'function') {
    try {
      dispose();
    } catch {
      /* 同上 */
    }
  }
} catch (error) {
  bad('apply() 执行', (error?.message ?? String(error)).split('\n')[0]);
} finally {
  // 还原真实 HOME，并把临时目录（含刚写的 config/log/登记簿）清掉
  if (realHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = realHome;
  if (realProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realProfile;
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* 删不掉就留着 */
  }
}

console.log('=== 3. patch 文件能否被 YAML 解析 ===');
let entryName = null;
/** patch 里这一行的 config（后面判断"副本目录/素材目录"要用它） */
let entryConfig = {};
/**
 * **没有 js-yaml 也要能自检**（2026-10-18 修）：
 * 这个脚本是给"刚装完、准备重启"的人用的，不能因为宿主 profile 里恰好没装 YAML 库就报错退出。
 * 有 js-yaml 就严格解析；没有就退化成行扫描（够判断"有没有那一行 / name 写的是谁"）。
 */
const patchText = readFileSync(PATCH, 'utf8');
let YAML = null;
try {
  YAML = createRequire(join(PROFILE, 'noop.js'))('js-yaml');
} catch {
  YAML = null;
}
try {
  if (YAML) {
    const doc = YAML.load(patchText);
    ok('cordis.patch.yml 解析通过', `${Array.isArray(doc) ? doc.length : '?'} 条`);
    const row = Array.isArray(doc) ? doc.find((r) => r && r.id === 'game-pet-watch') : null;
    if (!row) bad('patch 里有 game-pet-watch 行', '没找到（插件不会被加载）');
    else {
      entryName = row.name || null;
      entryConfig = row.config && typeof row.config === 'object' ? row.config : {};
      ok('patch 里有 game-pet-watch 行', entryName ? '入口=' + entryName : '（未写 name，用包默认入口）');
    }
  } else {
    console.log('  ℹ 没找到 js-yaml（宿主 profile 里没有这个库），改用行扫描');
    const lines = patchText.split(/\r?\n/);
    const at = lines.findIndex((l) => /^-\s*id:\s*game-pet-watch\s*$/.test(l));
    if (at === -1) bad('patch 里有 game-pet-watch 行', '没找到（插件不会被加载）');
    else {
      const rowLines = [];
      for (let i = at + 1; i < lines.length && !/^-\s/.test(lines[i]); i += 1) rowLines.push(lines[i]);
      const nameLine = rowLines.find((l) => /^\s+name:\s*/.test(l));
      entryName = nameLine ? nameLine.replace(/^\s+name:\s*/, '').replace(/^['"]|['"]$/g, '').trim() : null;
      const rootLine = rowLines.find((l) => /^\s+gpwRoot:\s*/.test(l));
      if (rootLine) entryConfig = { gpwRoot: rootLine.replace(/^\s+gpwRoot:\s*/, '').replace(/^['"]|['"]$/g, '').trim() };
      ok('patch 里有 game-pet-watch 行', entryName ? '入口=' + entryName : '（未写 name，用包默认入口）');
    }
  }
} catch (error) {
  bad('cordis.patch.yml 解析', (error?.message ?? String(error)).split('\n')[0]);
}

console.log('=== 4. patch 指向的入口是否存在 ===');
if (entryName) {
  /**
   * patch 里的 `name` 有两种写法：
   *   · `dsh-game-pet-watch/index-0.3.7.js` —— 包名 + 包内路径（剥掉前缀再找）
   *   · `dsh-game-pet-watch`              —— 只有包名（= 用包自己的默认入口）
   * 第一版两种情况都当文件路径拼，于是"只有包名"被误报成"文件不存在"（2026-10-18 修）。
   */
  if (!entryName.includes('/')) {
    const fallback = ['index.js', 'client.js'].find((f) => existsSync(join(ROOT, f)));
    if (fallback) ok(entryName + '（只有包名，用默认入口 ' + fallback + '）');
    else bad(entryName, '只有包名，但包里没有 index.js');
  } else {
    const subPath = entryName.slice(entryName.indexOf('/') + 1);
    const entryFile = join(ROOT, subPath);
    if (existsSync(entryFile)) ok(entryName + ' 存在');
    else bad(entryName, `文件不存在（找的是 ${entryFile}）`);
  }
}

console.log('=== 5. profile bundles ===');
try {
  const pkg = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'));
  const bundles = pkg?.dsh?.profile?.bundles ?? [];
  if (bundles.includes('dsh-game-pet-watch')) ok('bundles 含 dsh-game-pet-watch');
  else bad('bundles 含 dsh-game-pet-watch', '不在列表里 → 插件不会被加载');
  // **动画素材**在哪：现在允许"副本仓库自带"，不再只认 dsh-pet 包。
  // 顺序与插件一致：patch 里的 gpwRoot → 插件旁边的兄弟仓库 → profile 里的 dsh-pet。
  const gpwRoot = String(entryConfig?.gpwRoot || '').replace(/\/+$/, '');
  const petCandidates = [
    gpwRoot ? join(gpwRoot, 'assets', 'config.jsonc') : '',
    join(dirname(ROOT), 'dsh-pet-gpw', 'assets', 'config.jsonc'), // 兄弟仓库（开发布局）
    join(PROFILE, 'node_modules', 'dsh-pet', 'assets', 'config.jsonc'), // 借原版素材
  ].filter(Boolean);
  const petAssets = petCandidates.find((p) => existsSync(p));
  if (petAssets) ok('动画素材找得到', petAssets);
  else bad('动画素材', '三个候选位置都没有 assets/config.jsonc → 副本没有动画可用');

  if (bundles.includes('dsh-pet')) console.log('  ℹ 原版插件也在加载（屏幕上会多一只原版鱼）');
  else console.log('  ℹ 原版插件未加载（只跑副本；素材仍可用）');
} catch (error) {
  bad('package.json', (error?.message ?? String(error)).split('\n')[0]);
}

console.log('');
if (failed) {
  console.log(`❌ 自检发现 ${failed} 个问题 —— **先别重启 DSH**，修完再重启。`);
  process.exit(1);
}
console.log('✅ 自检全部通过，可以重启 DSH。');

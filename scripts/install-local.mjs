/**
 * **本地出包 + 安装**（"改仓库"工作流的固定入口）。
 *
 *   node scripts/install-local.mjs            # 打包两个仓库 → 装进 profile/node_modules 与 app-install
 *   node scripts/install-local.mjs --dry-run  # 只打印会做什么
 *   node scripts/install-local.mjs --keep-tgz # 保留 dist 里的 tgz（默认也保留，方便回滚）
 *
 * 为什么要有它：现在的安装是"从发布包装的"（`node_modules/dsh-game-pet-watch` 是实体副本，
 * 不是链接到仓库），所以**改仓库不会自动生效**。固定流程：
 *
 *   改仓库 → node scripts/install-local.mjs → 重启 DSH
 *
 * 它做的事：
 *   1. `npm pack` 插件仓库 → 解到 `<profile>/node_modules/dsh-game-pet-watch`（整份替换）；
 *   2. `npm pack` 桌宠仓库 → 解到 `<workspace>/app-install/dsh-pet-gpw`（整份替换）；
 *   3. profile/package.json：依赖写成 `file:<dist 里的 tgz>`，bundles 保证含本插件；
 *   4. profile/cordis.patch.yml：把 `game-pet-watch` 那行的 `name` 指到当前入口，
 *      并把 `gpwRoot` 设成第 2 步装出来的目录（**必须在 schema 声明过的键才不会丢**）。
 *
 * 幂等：重复跑就是重新装一遍，不会重复插行。
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = dirname(PLUGIN_ROOT);
/** 桌宠现在就在插件包里的 `pet/`（单包发布）；开发时仍可用 `--pet-repo` 指到别处 */
const PET_REPO = process.env.GPW_PET_REPO || join(PLUGIN_ROOT, 'pet');
const DSH = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE = join(DSH, 'profiles', process.env.DSH_PROFILE || 'desktop');
const INSTALL_PLUGIN = join(PROFILE, 'node_modules', 'dsh-game-pet-watch');
const PET_TARGET = join(WORKSPACE, 'app-install', 'dsh-pet-gpw');
const DIST = join(WORKSPACE, 'dist');
const DRY = process.argv.includes('--dry-run');

const pluginPkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
const petPkg = existsSync(join(PET_REPO, 'package.json'))
  ? JSON.parse(readFileSync(join(PET_REPO, 'package.json'), 'utf8'))
  : null;

/** 最新一代入口（index-x.y.z.js 里最大的那个） */
function latestEntry() {
  const versions = readdirSync(PLUGIN_ROOT)
    .map((f) => f.match(/^index-(\d+)\.(\d+)\.(\d+)\.js$/))
    .filter(Boolean)
    .map((m) => ({ text: `${m[1]}.${m[2]}.${m[3]}`, num: [Number(m[1]), Number(m[2]), Number(m[3])] }))
    .sort((a, b) => b.num[0] - a.num[0] || b.num[1] - a.num[1] || b.num[2] - a.num[2]);
  return versions[0]?.text ? `index-${versions[0].text}.js` : 'index.js';
}

const pack = (dir) => {
  // Windows 上 npm 是 npm.cmd：走 shell 才找得到（execFile 会 ENOENT）
  const out = execSync('npm pack --silent', { cwd: dir, encoding: 'utf8' }).trim().split(/\r?\n/).pop();
  const tgz = join(dir, out);
  if (!existsSync(tgz)) throw new Error('npm pack 没产出文件：' + out);
  mkdirSync(DIST, { recursive: true });
  const dst = join(DIST, out);
  cpSync(tgz, dst);
  return dst;
};

/**
 * 解包到目标目录（整份替换），返回**实际**装到哪。
 *
 * 两个坑：
 *   1. 先把包装到临时目录再整份拷过去 —— 避免"删了旧的、新的解一半"；
 *   2. 目标目录正在被运行的桌宠使用（Windows 会 EPERM，因为进程的 CWD 就在里面）→
 *      退到带时间戳的兄弟目录，并把调用方的 gpwRoot 指到新的那份。运行中的旧进程不受影响，
 *      重启 DSH 后自动切到新的。
 */
const extractInto = (tgz, target) => {
  const tmp = join(tmpdir(), `gpw-extract-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  execSync(`tar -xzf "${tgz}" -C "${tmp}" --strip-components=1`, { stdio: 'inherit' });

  /**
   * 先解到临时目录，再"合并覆盖"进目标（不先 rm 目标）。
   *
   * 为什么不"删了再拷"：运行中的 DSH 会占用包目录，rmSync 可能删掉一半才抛 EPERM，
   * 目标就变成半残 —— 实测就这样把 package.json / index.js / client.js 删没了，
   * 设置页显示「异常 / 包不可用」。合并覆盖最坏只是"没覆盖全"，校验能发现并重试。
   */
  mkdirSync(target, { recursive: true });
  cpSync(tmp, target, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  return target;
};

/**
 * **删掉安装目录里的旧版本入口**（规则：只留当前这一版的 index-<x.y.z>.js）。
 *
 * 为什么要有：安装是"合并覆盖"，不会删旧文件 —— 实测装到 1.5.5 时目录里还躺着
 * index-1.4.0 ~ index-1.5.4 共 10 个旧入口。它们不会被加载（patch 只指一个），
 * 但会一直留在 profile 里，越装越乱。
 */
const pruneOldEntries = (dir, keepEntry) => {
  let removed = 0;
  for (const file of readdirSync(dir)) {
    if (!/^index-\d+\.\d+\.\d+\.js$/.test(file)) continue;
    if (file === keepEntry) continue;
    try {
      rmSync(join(dir, file), { force: true });
      removed += 1;
    } catch {
      /* 被占用就下次再说，不影响加载 */
    }
  }
  if (removed) console.log('  🧹 删掉旧入口 ' + removed + ' 个（只留 ' + keepEntry + '）');
};

/** 装完必须有的文件（少一个宿主就加载不了） */
const REQUIRED = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml'];

/** 校验 + 缺失时重试一次；仍然缺就抛错（宁可安装失败，也不要静默装出一个"包不可用"） */
const verifyInstalled = (dir, entry, tgz) => {
  const need = [...REQUIRED, entry].filter(Boolean);
  const missing = () => need.filter((f) => !existsSync(join(dir, f)));
  if (!missing().length) return;
  console.log('  ⚠ 安装不完整（缺 ' + missing().join('、') + '），重试一次…');
  try {
    extractInto(tgz, dir);
  } catch {
    /* 重试失败就看下面的 still */
  }
  const still = missing();
  if (still.length) {
    throw new Error('安装后仍然缺文件：' + still.join('、') + '（多半是 DSH 正在占用该目录，关掉 DSH 再装）');
  }
  console.log('  ✅ 重试后完整');
};

/** 在 patch 里保证：row.name 指向入口、row.config.gpwRoot 指向装出来的桌宠 */
function patchProfile(entry, petRoot, dry) {
  const file = join(PROFILE, 'cordis.patch.yml');
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  let start = lines.findIndex((l) => /^-\s*id:\s*game-pet-watch\s*$/.test(l));
  /**
   * **行不存在就补回来**（2026-10-27 实测：DSH 重写 profile 之后那一行会整段消失，
   * 下次重启插件直接不加载；旧写法在这里 throw，反而挡住了修复）。
   */
  if (start === -1) {
    if (!dry) {
      const row = [
        '- id: game-pet-watch',
        `  name: 'dsh-game-pet-watch/${entry}'`,
        '  config:',
        `    gpwRoot: '${petRoot.replace(/\\/g, '/')}'`,
        '',
      ];
      const trimmed = text.endsWith('\n') ? text : text + '\n';
      writeFileSync(`${file}.bak-install-${Date.now()}`, text, 'utf8');
      writeFileSync(file, trimmed + row.join('\n'), 'utf8');
    }
    console.log('  ⚠ patch 里没有 game-pet-watch 行，已补回（name + gpwRoot）');
    return { nameDone: true, rootDone: true, recreated: true };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^-\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let nameDone = false;
  let rootDone = false;
  for (let i = start + 1; i < end; i += 1) {
    if (/^\s+name:\s*/.test(lines[i])) {
      lines[i] = lines[i].replace(/name:\s*.*$/, `name: 'dsh-game-pet-watch/${entry}'`);
      nameDone = true;
    } else if (/^\s+gpwRoot:\s*/.test(lines[i])) {
      lines[i] = lines[i].replace(/gpwRoot:\s*.*$/, `gpwRoot: '${petRoot.replace(/\\/g, '/')}'`);
      rootDone = true;
    }
  }
  if (!rootDone) {
    const cfg = lines.findIndex((l, i) => i > start && i < end && /^\s+config:\s*$/.test(l));
    if (cfg !== -1) {
      lines.splice(cfg + 1, 0, `    gpwRoot: '${petRoot.replace(/\\/g, '/')}'`);
      rootDone = true;
    }
  }
  const next = lines.join('\n');
  if (!dry && next !== text) {
    writeFileSync(`${file}.bak-install-${Date.now()}`, text, 'utf8');
    writeFileSync(file, next, 'utf8');
  }
  return { nameDone, rootDone };
}

console.log(`出包安装${DRY ? '（dry-run）' : ''}`);
console.log(`  插件仓库 = ${PLUGIN_ROOT}（v${pluginPkg.version}）`);
console.log(`  桌宠仓库 = ${PET_REPO}${petPkg ? `（v${petPkg.version}）` : '（不存在，跳过桌宠）'}`);
console.log(`  安装目标 = ${INSTALL_PLUGIN}`);
console.log(`  桌宠目标 = ${PET_TARGET}`);

const entry = latestEntry();
console.log(`  当前入口 = ${entry}`);

if (DRY) {
  console.log('  [dry] 会 pack 两个仓库、解包并整份替换安装目录、更新 profile 依赖/bundles 与 patch 的 name/gpwRoot');
  process.exit(0);
}

const pluginTgz = pack(PLUGIN_ROOT);
console.log('  插件包：' + pluginTgz);
const pluginDir = extractInto(pluginTgz, INSTALL_PLUGIN);
verifyInstalled(pluginDir, entry, pluginTgz);
/** 装完顺手清旧入口：安装是合并覆盖，不删的话目录里会一直堆 index-1.4.x / 1.5.x */
pruneOldEntries(pluginDir, entry);
console.log(`  已安装插件 → ${pluginDir}（${readdirSync(pluginDir).length} 个条目）`);

/** 桌宠实际装到了哪（被占用时会换成带时间戳的目录），后面 gpwRoot 要指它 */
let petDir = '';
if (petPkg) {
  const petTgz = pack(PET_REPO);
  console.log('  桌宠包：' + petTgz);
  petDir = extractInto(petTgz, PET_TARGET);
  console.log(`  已安装桌宠 → ${petDir}`);
}

// profile: 依赖 + bundles
const pkgFile = join(PROFILE, 'package.json');
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['dsh-game-pet-watch'] = `file:${pluginTgz.replace(/\\/g, '/')}`;
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
const bundles = new Set(pkg.dsh.profile.bundles || []);
bundles.add('dsh-game-pet-watch');
pkg.dsh.profile.bundles = [...bundles];
writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('  profile 依赖/bundles 已更新');

const patched = patchProfile(entry, petDir || PET_TARGET, false);
console.log(`  patch 已更新（name=${patched.nameDone}，gpwRoot=${patched.rootDone}）`);

/**
 * **还要写进自管配置**（`<DSH_HOME>/game-pet-watch/config.json`）。
 *
 * 为什么两处都写：宿主只转发"bundle patch 里声明过"的键（这一版已经补上了 gpwRoot），
 * 但**自管配置的优先级更高、且完全不经过宿主** —— 实测 patch 里写了 gpwRoot、
 * 插件里仍然是空串（宿主过滤），最后是靠 `/config` 接口写进自管配置才生效的。
 * 所以安装脚本两处都写：patch 给"新装的人"看，自管配置保证"现在这台"一定对。
 */
if (petDir) {
  const localFile = join(DSH, 'game-pet-watch', 'config.json');
  try {
    mkdirSync(dirname(localFile), { recursive: true });
    let local = {};
    try {
      local = JSON.parse(readFileSync(localFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      local = {};
    }
    local.gpwRoot = petDir.replace(/\\/g, '/');
    local._updatedAt = new Date().toISOString();
    local._source = 'install-local';
    writeFileSync(localFile, JSON.stringify(local, null, 2), 'utf8');
    console.log('  自管配置已更新 gpwRoot = ' + local.gpwRoot);
  } catch (error) {
    console.log('  ⚠ 自管配置写入失败：' + (error?.message ?? error));
  }
}

/**
 * **清理旧的桌宠安装目录**：只删 `app-install/` 下名字像 `dsh-pet-gpw*`、且**不是当前这一份**
 * 的目录。删不掉的（正被运行中的进程占用）直接跳过 —— 下次安装还会再试。
 */
if (petDir) {
  try {
    const base = dirname(PET_TARGET);
    const keep = petDir;
    let removed = 0;
    for (const name of readdirSync(base)) {
      if (!/^dsh-pet-gpw/.test(name)) continue;
      const full = join(base, name);
      if (full === keep) continue;
      try {
        rmSync(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
        removed += 1;
      } catch {
        /* 正被占用：下次再说 */
      }
    }
    if (removed) console.log(`  已清理 ${removed} 份旧的桌宠安装`);
  } catch {
    /* 清理失败不影响安装结果 */
  }
}

console.log('\n✅ 安装完成。**重启 DSH** 生效。');

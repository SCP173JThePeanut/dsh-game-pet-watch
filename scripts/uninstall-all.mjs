/**
 * **卸载（极限测试用）**：把插件从 DSH 卸掉、把数据删掉，可选连仓库一起删。
 *
 *   node scripts/uninstall-all.mjs --dry-run           # 只打印计划（不带 --yes 时就是 dry-run）
 *   node scripts/uninstall-all.mjs --yes               # 真删：profile 挂载 + 安装 + 数据
 *   node scripts/uninstall-all.mjs --yes --repos       # 连两个仓库一起删（**先跑 backup-all**）
 *   node scripts/uninstall-all.mjs --yes --keep-data   # 只卸挂载，不动数据
 *
 * 具体做什么：
 *   1. profile 的 package.json：删 `dsh-game-pet-watch` 依赖 + bundles 里那一行；
 *   2. profile 的 cordis.patch.yml：删掉 `- id: game-pet-watch` 整段（旧文件自动备份）；
 *   3. 删 profile/node_modules 里那个安装（**只删 junction 链接，不动目标仓库**）；
 *   4. 删数据：`~/.dsh/game-pet-watch`、`~/.dsh/dsh-pet-gpw*`、`~/.dsh/fish-board`；
 *   5. `--repos`：删 `G:\goh agent\dsh-game-pet-watch` 与 `dsh-pet-gpw`。
 *
 * 安全：不带 `--yes` 绝不删；每一步都打印。删之前先
 * `node scripts/backup-all.mjs`（备份里带 manifest 与 RESTORE.md）。
 */
import { existsSync, lstatSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = dirname(ROOT);
const DSH = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE = join(DSH, 'profiles', process.env.DSH_PROFILE || 'desktop');
const PROFILE_PKG = join(PROFILE, 'package.json');
const PROFILE_PATCH = join(PROFILE, 'cordis.patch.yml');

const argv = process.argv.slice(2);
const YES = argv.includes('--yes');
const REPOS = argv.includes('--repos');
const KEEP_DATA = argv.includes('--keep-data');
const PACKAGE = 'dsh-game-pet-watch';

const plan = [];
const log = (s) => console.log((YES ? '  ' : '  [dry] ') + s);

/** 从 patch 里删掉 game-pet-watch 那一整段（行式操作，不引入 YAML 依赖） */
function stripPatchRow(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^-\s*id:\s*game-pet-watch\s*$/.test(l));
  if (start === -1) return { text, removed: false };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^-\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  lines.splice(start, end - start);
  return { text: lines.join('\n'), removed: true };
}

/** 删安装：链接只删链接本身（rmdirSync 对 junction 不跟进目标），普通目录才递归 */
function removeInstalled(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    rmdirSync(path);
    return 'link';
  }
  if (st.isDirectory()) {
    rmSync(path, { recursive: true, force: true });
    return 'dir';
  }
  rmSync(path, { force: true });
  return 'file';
}

console.log(`卸载 ${PACKAGE}（profile = ${PROFILE}）${YES ? '' : ' —— dry-run，加 --yes 才真删'}`);

// 1. profile package.json
if (existsSync(PROFILE_PKG)) {
  const pkg = JSON.parse(readFileSync(PROFILE_PKG, 'utf8'));
  const hasDep = Boolean(pkg.dependencies && PACKAGE in pkg.dependencies);
  const bundles = pkg?.dsh?.profile?.bundles;
  const hasBundle = Array.isArray(bundles) && bundles.includes(PACKAGE);
  log(`profile 依赖里有 ${PACKAGE}: ${hasDep}；bundles 里有: ${hasBundle}`);
  if (YES && (hasDep || hasBundle)) {
    if (hasDep) delete pkg.dependencies[PACKAGE];
    if (hasBundle) pkg.dsh.profile.bundles = bundles.filter((b) => b !== PACKAGE);
    writeFileSync(PROFILE_PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    log('已从 profile 摘除（依赖 + bundles）');
  }
  if (hasDep || hasBundle) plan.push('profile');
}

// 2. profile patch 行
if (existsSync(PROFILE_PATCH)) {
  const text = readFileSync(PROFILE_PATCH, 'utf8');
  const { text: next, removed } = stripPatchRow(text);
  log(`patch 里有 game-pet-watch 行: ${removed}`);
  if (YES && removed) {
    writeFileSync(`${PROFILE_PATCH}.bak-uninstall-${Date.now()}`, text, 'utf8');
    writeFileSync(PROFILE_PATCH, next, 'utf8');
    log('已从 profile patch 删掉那一行（旧文件已备份 .bak-uninstall-*）');
  }
  if (removed) plan.push('patch');
}

// 3. node_modules 里的安装
const installed = join(PROFILE, 'node_modules', PACKAGE);
if (existsSync(installed)) {
  log(`node_modules/${PACKAGE} 存在`);
  if (YES) {
    try {
      const kind = removeInstalled(installed);
      log(`已删除安装（${kind}）`);
    } catch (error) {
      log('删安装失败：' + (error?.message ?? error));
    }
  }
  plan.push('install');
}

// 4. 数据
const dataDirs = [
  join(DSH, 'game-pet-watch'),
  join(DSH, 'dsh-pet-gpw'),
  join(DSH, 'dsh-pet-gpw-second'),
  join(DSH, 'dsh-pet-gpw-gpw'),
  join(DSH, 'dsh-pet-gpw-current'),
  join(DSH, 'fish-board'),
];
for (const dir of dataDirs) {
  if (!existsSync(dir)) continue;
  if (KEEP_DATA) {
    log(`保留数据（--keep-data）：${dir}`);
    continue;
  }
  log(`删数据：${dir}`);
  if (YES) rmSync(dir, { recursive: true, force: true });
  plan.push('data:' + dir);
}

// 5. 仓库
if (REPOS) {
  for (const dir of [join(WORKSPACE, PACKAGE), join(WORKSPACE, 'dsh-pet-gpw')]) {
    if (!existsSync(dir)) continue;
    log(`删仓库：${dir}`);
    if (YES) rmSync(dir, { recursive: true, force: true });
    plan.push('repo:' + dir);
  }
}

console.log(`\n计划动作 ${plan.length} 项${YES ? '（已执行）' : '（dry-run，未执行）'}`);
if (!YES) console.log('确认无误后加 --yes 真删。删之前先跑：node scripts/backup-all.mjs');
process.exit(0);

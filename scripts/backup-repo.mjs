/**
 * 仓库快照（`node scripts/backup-repo.mjs [--label 改啥之前]`）。
 *
 * 为什么需要它（2026-10-17 血的教训 ✗）：
 *   我用 `pnpm install`（`file:` 形式的包引用 ✗）把 node_modules 里的 **junction 换成实体副本** ✓，
 *   pnpm 清理旧链接时**顺着 junction 把本仓库整个清空了** ✗✗ —— 125 个文件瞬间没了 ✓，
 *   最后是从 pnpm 复制出去的那份包里救回来的 ✓（`scripts/`、`tests/`、`web/` 还是丢了 ✓）。
 *
 * 现在的策略：**动代码之前先快照** ✓，保留最近 N 份 ✓。
 *
 *   node scripts/backup-repo.mjs                    # 直接快照
 *   node scripts/backup-repo.mjs --label before-multi-fish
 *   node scripts/backup-repo.mjs --list             # 看现有快照
 *   node scripts/backup-repo.mjs --keep 5           # 只留最近 5 份（默认 10）
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PARENT = dirname(PACKAGE_ROOT);
/** 快照统一放 `<父目录>/archive/backups/` —— 以前直接堆在父目录，几十份把工作区根目录糊住了 */
const BACKUP_DIR = join(PARENT, 'archive', 'backups');
const BASE = `${PACKAGE_ROOT.split(/[\\/]/).pop()}.backup`;

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

/** 不复制的东西：历史快照、依赖、垃圾 */
const SKIP = /(^|[\\/])(node_modules|\.git|cleanroom-|.*\.bak-|.*\.backup-)/;

function listBackups() {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter((n) => n.startsWith(`${BASE}-`))
    .map((n) => ({ name: n, path: join(BACKUP_DIR, n), at: statSync(join(BACKUP_DIR, n)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
}

if (argv.includes('--list')) {
  const list = listBackups();
  console.log('backups in ' + BACKUP_DIR + ': ' + list.length);
  for (const b of list) {
    console.log('  ' + new Date(b.at).toLocaleString() + '  ' + b.name);
  }
  process.exit(0);
}

const label = argOf('--label', '').replace(/[^\w.-]+/g, '_').slice(0, 40);
const keep = Math.max(1, Number(argOf('--keep', '10')) || 10);
const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..*$/, '');
const dest = join(BACKUP_DIR, `${BASE}-${stamp}${label ? '-' + label : ''}`);

if (existsSync(dest)) {
  console.log('这一秒的快照已存在：' + dest);
  process.exit(0);
}

mkdirSync(BACKUP_DIR, { recursive: true });
cpSync(PACKAGE_ROOT, dest, {
  recursive: true,
  filter: (src) => !SKIP.test(src.slice(PARENT.length)),
});
const files = (function count(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? count(join(dir, e.name)) : 1;
  }
  return n;
})(dest);
console.log('快照完成：' + dest);
console.log(`  ${files} 个文件`);

const all = listBackups();
for (const old of all.slice(keep)) {
  try {
    rmSync(old.path, { recursive: true, force: true });
    console.log('  清掉旧快照：' + old.name);
  } catch {
    /* 删不掉就算了 */
  }
}
console.log(`  现有快照 ${Math.min(all.length, keep)} 份（上限 ${keep}，用 --keep 调）`);

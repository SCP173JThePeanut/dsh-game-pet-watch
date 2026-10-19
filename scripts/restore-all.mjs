/**
 * **还原**：从 `backup-all.mjs` 的备份目录把记录/依赖/挂载恢复回来。
 *
 *   node scripts/restore-all.mjs --from "D:\goh-agent-backup-20261018-014700" --yes
 *   node scripts/restore-all.mjs --from <备份> --data-only    # 只恢复数据（配置/记忆/图库）
 *   node scripts/restore-all.mjs --from <备份> --repos-only   # 只恢复两个仓库
 *
 * 做的事（按 `manifest.json` 走）：
 *   1. 仓库 → 恢复到原来的路径（`items/plugin-repo`、`items/pet-repo`）；
 *   2. 数据 → 恢复到 `~/.dsh/...`（先备份现有同名目录为 `*.before-restore-<时间>`）；
 *   3. profile 的 `package.json` / `cordis.patch.yml` → 恢复原文件（依赖、bundles、人设都在里面）。
 *
 * 注意：恢复 profile 的两个文件会**覆盖**当前内容（先自动备份一份）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = dirname(ROOT);
const DSH = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE = join(DSH, 'profiles', process.env.DSH_PROFILE || 'desktop');

const argv = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const FROM = argOf('--from');
const YES = argv.includes('--yes');
const DATA_ONLY = argv.includes('--data-only');
const REPOS_ONLY = argv.includes('--repos-only');

if (!FROM || !existsSync(join(FROM, 'manifest.json'))) {
  console.error('用法：node scripts/restore-all.mjs --from <备份目录> [--yes] [--data-only|--repos-only]');
  console.error('备份目录里要有 manifest.json（由 scripts/backup-all.mjs 生成）');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(FROM, 'manifest.json'), 'utf8'));
console.log(`从 ${FROM} 还原（${manifest.items.length} 项，备份于 ${manifest.stamp}）${YES ? '' : ' —— dry-run，加 --yes 才写盘'}`);

const stampNow = Date.now();
/** 备份项名 → 目标路径（数据与仓库用备份时记录的原路径；profile 文件固定回 profile） */
const targetOf = (item) => {
  if (item.name === 'profile-package.json') return join(PROFILE, 'package.json');
  if (item.name === 'profile-cordis.patch.yml') return join(PROFILE, 'cordis.patch.yml');
  if (item.src) return item.src; // 备份时记了原路径，直接回去
  return '';
};

for (const item of manifest.items) {
  const isRepo = item.name === 'plugin-repo' || item.name === 'pet-repo';
  if (DATA_ONLY && isRepo) continue;
  if (DATA_ONLY && item.name.startsWith('profile-')) continue;
  if (REPOS_ONLY && !isRepo) continue;

  const src = join(FROM, item.dst);
  const dst = targetOf(item);
  if (!dst) {
    console.log(`  ⚠ 不知道恢复到哪：${item.name}`);
    continue;
  }
  console.log(`  ${YES ? '→' : '·'} ${item.name} → ${dst}`);
  if (!YES) continue;
  try {
    if (existsSync(dst)) {
      const keep = `${dst}.before-restore-${stampNow}`;
      renameSync(dst, keep);
      console.log(`    现有内容已挪到 ${keep}`);
    }
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true });
  } catch (error) {
    console.log(`    ❌ 失败：${error?.message ?? error}`);
  }
}

if (!YES) {
  console.log('\ndry-run：确认后加 --yes。');
  process.exit(0);
}
writeFileSync(join(FROM, 'restored-at.txt'), new Date().toISOString() + '\n', 'utf8');
console.log('\n✅ 还原完成。重启 DSH 后生效。');

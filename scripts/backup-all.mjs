/**
 * **全量备份**：把"记录（数据）+ 依赖（两个仓库）+ profile 挂载"整包搬到一个目录。
 *
 *   node scripts/backup-all.mjs                     # 备份到 D:\goh-agent-backup-<时间戳>
 *   node scripts/backup-all.mjs --to D:\somewhere
 *   node scripts/backup-all.mjs --dry-run           # 只打印计划
 *
 * 备份内容（默认全都要）：
 *   · 插件仓库 G:\goh agent\dsh-game-pet-watch（含 index-*.js / scripts / tests / tgz）
 *   · 桌宠仓库 G:\goh agent\dsh-pet-gpw（含自带 assets 60MB）
 *   · 插件数据 ~/.dsh/game-pet-watch（配置、记忆、图库描述、日志）
 *   · 每条鱼的用户目录 ~/.dsh/dsh-pet-gpw*（state/prefs/表情包）
 *   · 公共登记簿 ~/.dsh/fish-board
 *   · profile 的 package.json + cordis.patch.yml（挂载与配置，含人设）
 *
 * 备份完会**逐项核对文件数与字节数**，并写 `manifest.json` 与 `RESTORE.md`。
 * 还原用 `scripts/restore-all.mjs --from <这个目录>`。
 *
 * 为什么不用 robocopy/PowerShell：`[System.IO.File]` 相对路径会跟着进程 CWD 跑（踩过），
 * 而且我们要一份机器可读的 manifest 与校验结果 —— 备份没核对过等于没备份。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync } from 'node:fs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = dirname(ROOT);
const HOME = homedir();
const DSH = process.env.DSH_HOME || join(HOME, '.dsh');
const PROFILE = join(DSH, 'profiles', process.env.DSH_PROFILE || 'desktop');

const argv = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DRY = argv.includes('--dry-run');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const TO = argOf('--to', join('D:', `goh-agent-backup-${stamp}`));

/** 要备份的东西：{ name, src, required } */
const ITEMS = [
  { name: 'plugin-repo', src: join(WORKSPACE, 'dsh-game-pet-watch'), required: true },
  { name: 'pet-repo', src: join(WORKSPACE, 'dsh-pet-gpw'), required: true },
  { name: 'plugin-data', src: join(DSH, 'game-pet-watch'), required: false },
  { name: 'pet-user-1', src: join(DSH, 'dsh-pet-gpw'), required: false },
  { name: 'pet-user-2', src: join(DSH, 'dsh-pet-gpw-second'), required: false },
  { name: 'pet-user-gpw-old', src: join(DSH, 'dsh-pet-gpw-gpw'), required: false },
  { name: 'pet-user-current-old', src: join(DSH, 'dsh-pet-gpw-current'), required: false },
  { name: 'fish-board', src: join(DSH, 'fish-board'), required: false },
  { name: 'profile-package.json', src: join(PROFILE, 'package.json'), required: true },
  { name: 'profile-cordis.patch.yml', src: join(PROFILE, 'cordis.patch.yml'), required: true },
];

const bytesOf = (dir) => {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files += 1;
        try {
          bytes += statSync(p).size;
        } catch {
          /* 读不到就不计 */
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
};

const copyTree = (src, dst) => {
  if (statSync(src).isFile()) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    return;
  }
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
};

console.log(`备份到：${TO}${DRY ? '（dry-run，不写盘）' : ''}`);
const manifest = { stamp, host: process.env.COMPUTERNAME || '', platform: process.platform, to: TO, items: [] };
let totalFiles = 0;
let totalBytes = 0;
let failed = 0;

for (const item of ITEMS) {
  if (!existsSync(item.src)) {
    if (item.required) {
      console.log(`  ❌ 缺少必需项：${item.src}`);
      failed += 1;
    } else {
      console.log(`  - 跳过（不存在）：${item.name}`);
    }
    continue;
  }
  const isFile = statSync(item.src).isFile();
  const stat = isFile ? { files: 1, bytes: statSync(item.src).size } : bytesOf(item.src);
  console.log(`  ${DRY ? '·' : '→'} ${item.name}: ${stat.files} 个文件 / ${(stat.bytes / 1024 / 1024).toFixed(1)} MB`);
  if (!DRY) {
    const dst = join(TO, 'items', item.name);
    copyTree(item.src, dst);
    const after = isFile ? { files: 1, bytes: statSync(dst).size } : bytesOf(dst);
    const ok = after.files === stat.files && after.bytes === stat.bytes;
    if (!ok) {
      console.log(`    ❌ 核对失败：期望 ${stat.files}/${stat.bytes}，实际 ${after.files}/${after.bytes}`);
      failed += 1;
    } else {
      console.log('    ✅ 核对通过');
    }
    manifest.items.push({
      name: item.name,
      src: item.src,
      dst: relative(TO, dst),
      kind: isFile ? 'file' : 'dir',
      files: after.files,
      bytes: after.bytes,
      verified: ok,
    });
  }
  totalFiles += stat.files;
  totalBytes += stat.bytes;
}

console.log(`合计：${totalFiles} 个文件 / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

if (!DRY) {
  manifest.totalFiles = totalFiles;
  manifest.totalBytes = totalBytes;
  manifest.verified = failed === 0;
  mkdirSync(TO, { recursive: true });
  writeFileSync(join(TO, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(
    join(TO, 'RESTORE.md'),
    [
      '# 还原说明',
      '',
      '```powershell',
      'cd "G:\\goh agent\\dsh-game-pet-watch"   # 如果仓库也被删了，先把 items/plugin-repo 拷回去',
      'node scripts/restore-all.mjs --from "' + TO + '" --yes',
      '```',
      '',
      '只还原数据（不动仓库与 profile）：`--data-only`',
      '只还原仓库（不动数据）：`--repos-only`',
      '',
      '备份时间：' + new Date().toISOString(),
      '清单：manifest.json（逐项文件数/字节数 + verified）',
      '',
    ].join('\n'),
    'utf8',
  );
}

console.log(failed ? `\n❌ 备份有 ${failed} 个问题，别急着删东西。` : '\n✅ 备份完成且逐项核对通过。');
process.exit(failed ? 1 : 0);

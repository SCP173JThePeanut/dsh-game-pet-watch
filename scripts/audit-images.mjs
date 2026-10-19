/**
 * 图库对账（`node scripts/audit-images.mjs`）—— 回答"图是不是都读进来了"。
 *
 * 四件事分开看（混在一起说不清 ✗）：
 *   ① 磁盘上有、目录里没有 → 没读进来 ✓（同步没跑到 / 扫描器不认扩展名 ✓）
 *   ② 目录里有、但没描述     → 挑不到它 ✗
 *   ③ 目录里有、磁盘上没有   → 僵尸条目 ✓
 *   ④ QQ 收的（`qq-` 前缀或数字名映射）单独统计 ✓
 *
 * ⚠️ 控制台只打 ASCII ✓；中文写 UTF-8 文件（image-audit.txt ✓）。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA = 'C:/Users/Kishin/.dsh/game-pet-watch';
const USER_MEMES = 'C:/Users/Kishin/.dsh/dsh-pet-gpw/memes';
const UPSTREAM = 'C:/Users/Kishin/.dsh/profiles/desktop/node_modules/dsh-pet';
const OUT = join(process.env.TEMP ?? 'C:/Windows/Temp', 'image-audit.txt');

const cats = ['image-catalog-current.json', 'image-catalog-legacy.json', 'image-catalog.json'];
const LINES = [];
const say = (s) => {
  LINES.push(String(s));
  console.log(String(s).replace(/[^\x20-\x7e]/g, '.'));
};

function scan(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!/\.(png|webp|jpg|jpeg|gif|bmp)$/i.test(name)) continue;
    try {
      out.push({ file: name, stem: name.replace(/\.[^.]+$/, ''), bytes: statSync(join(dir, name)).size });
    } catch {
      /* skip */
    }
  }
  return out;
}

// 数字名 ↔ 旧名映射（改名时写的 ✓）
let byId = {};
try {
  for (const m of JSON.parse(readFileSync(join(DATA, 'image-id-map.json'), 'utf8'))) {
    if (m && m.id) byId[m.id] = m.oldName || '';
  }
} catch {
  byId = {};
}

const diskUser = scan(USER_MEMES);
const diskUp = scan(join(UPSTREAM, 'assets', 'memes')).concat(scan(join(UPSTREAM, 'memes')));
say('=== disk ===');
say(`  user memes   : ${diskUser.length} files (${(diskUser.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(1)} MB)`);
say(`  upstream     : ${diskUp.length} files`);
const qqDisk = diskUser.filter((f) => f.stem.startsWith('qq-'));
say(`  qq-sourced   : ${qqDisk.length} (disk)`);

for (const cat of cats) {
  const p = join(DATA, cat);
  if (!existsSync(p)) {
    say(`\n=== ${cat} === (missing)`);
    continue;
  }
  const items = (JSON.parse(readFileSync(p, 'utf8')).items) || {};
  const names = Object.keys(items);
  const noText = names.filter((n) => !String(items[n]?.text ?? '').trim());
  const zombies = names.filter((n) => {
    const f = String(items[n]?.file ?? items[n]?.sheet ?? '');
    return !f || !existsSync(f);
  });
  const diskAll = new Map([...diskUser, ...diskUp].map((f) => [f.stem, f]));
  const missing = [...diskAll.keys()].filter((n) => !items[n]);
  say(`\n=== ${cat} ===`);
  say(`  items=${names.length} withText=${names.length - noText.length} noText=${noText.length}`);
  say(`  1) on disk, not in catalog : ${missing.length}` + (missing.length ? ' -> ' + missing.slice(0, 6).join(', ') : ''));
  say(`  2) in catalog, no text     : ${noText.length}` + (noText.length ? ' -> ' + noText.slice(0, 6).join(', ') : ''));
  say(`  3) zombies (file gone)     : ${zombies.length}` + (zombies.length ? ' -> ' + zombies.slice(0, 6).join(', ') : ''));
  say(`  sample keys: ${names.slice(0, 4).join(', ')}`);
}

writeFileSync(OUT, LINES.join('\n'), 'utf8');
console.log('\n  details (UTF-8) -> ' + OUT);

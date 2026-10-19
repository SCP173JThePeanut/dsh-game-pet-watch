/**
 * 配图 CSS 一致性检查（`node scripts/check-image-css.mjs`）
 *
 * 为什么需要（OpenCode 复核时发现的）：P1-1 修的是"长图被裁 + 大图太小"，
 * 但这个 CSS 在仓库里有**多份拷贝**（web overlay 的 `lib/client.js`、
 * 桌面 helper 的 `shared-core.js`、桌面副本的 `electron-helper-copy/shared-core.js`…）。
 * 我上次只改了实际在用的那一份 → 其它界面仍然是老行为。
 *
 * 所以这里**动态扫描**（不写死名单）：凡是出现 `pet-bub-img` 的文件都必须满足：
 *   ① 有高度上限（避免竖长图顶出窗口）
 *   ② `object-fit:contain`（不裁画面——表情包文字常在最下面，一裁就废）
 *   ③ 没有老的写死宽度 `*0.34`
 * 以后新增第 4 份拷贝也会被这个脚本抓到。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2] ?? '.';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'sheets', 'shots']);
const MARK = 'pet-bub-img';

/** 递归收集候选文件（只看代码/样式，不看二进制） */
function walk(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(js|cjs|mjs|ts|html|css)$/.test(name)) out.push(full);
  }
  return out;
}

let failed = 0;
const files = walk(ROOT).filter((f) => {
  try {
    return readFileSync(f, 'utf8').includes(MARK);
  } catch {
    return false;
  }
});

console.log(`扫描 ${ROOT}：找到 ${files.length} 个含 "${MARK}" 的文件`);

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  /**
   * 只检查**真的定义 CSS** 的地方：规则体里必须紧跟 `display:`。
   *
   * 为什么要这条：本脚本自己的正则里也写着 `pet-bub-img{` ——
   * 用宽松判据会把它当成"一份没修的拷贝"（第一次跑就是这么误报的）。
   */
  if (!/pet-bub-img\{[^"'`]{0,160}display:/.test(text)) {
    console.log(`  ·  ${file}  （只引用类名，不定义样式 → 跳过）`);
    continue;
  }
  const hasHeightCap = /pet-bub-img\s*\{[\s\S]{0,400}?max-height/.test(text);
  const hasContain = /pet-bub-img\s*\{[\s\S]{0,400}?object-fit:\s*contain/.test(text);
  const hasOldFixedWidth = /\*0\.34\)/.test(text);
  const problems = [];
  if (!hasHeightCap) problems.push('缺高度上限（竖长图会被切）');
  if (!hasContain) problems.push('缺 object-fit:contain（会裁画面）');
  if (hasOldFixedWidth) problems.push('仍有老规则 *0.34 写死宽度');
  if (problems.length) {
    console.log(`  ❌ ${file}`);
    for (const p of problems) console.log(`       - ${p}`);
    failed += 1;
  } else {
    console.log(`  ✅ ${file}`);
  }
}

console.log('');
console.log(failed ? `❌ ${failed} 处配图 CSS 没跟上（跑 scripts/fix-image-css.py 补齐）` : '✅ 所有配图 CSS 都是新规则');
process.exit(failed ? 1 : 0);

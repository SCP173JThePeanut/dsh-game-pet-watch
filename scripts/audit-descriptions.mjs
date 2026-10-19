/**
 * 描述审计（`node scripts/audit-descriptions.mjs [--fish legacy|current]`）。
 *
 * 回答"转出来的描述靠不靠谱" ✓：
 *   · 各鱼描述目录里：有多少条、多少有描述、多少没描述 ✓
 *   · 有没有"串味"（出现 动画/帧/索引卡 这类属于动画目录的词 ✗）
 *   · 有没有报错占位（失败/错误/undefined ✗）
 *   · 重复描述、过短的 ✓
 *   · 抽样看风格是否像"给模型挑图用的索引" ✓
 *
 * ⚠️ 控制台只打 ASCII ✓；中文写 UTF-8 文件（desc-audit.txt ✓）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA = 'C:/Users/Kishin/.dsh/game-pet-watch';
const OUT = join(process.env.TEMP ?? 'C:/Windows/Temp', 'desc-audit.txt');
const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1] || d;
};
const only = argOf('--fish', '');

const cats = ['image-catalog-current.json', 'image-catalog-legacy.json', 'image-catalog.json']
  .filter((n) => !only || n.includes(only));

const LINES = [];
const say = (s) => {
  LINES.push(String(s));
  console.log(String(s).replace(/[^\x20-\x7e]/g, '.'));
};

for (const cat of cats) {
  const p = join(DATA, cat);
  if (!existsSync(p)) {
    say(`\n=== ${cat} === (missing)`);
    continue;
  }
  const items = (JSON.parse(readFileSync(p, 'utf8')).items) || {};
  const names = Object.keys(items);
  let noText = 0;
  let short = 0;
  const smell = [];
  const err = [];
  const dup = new Map();
  for (const n of names) {
    const t = String(items[n]?.text ?? '').trim();
    if (!t) {
      noText += 1;
      continue;
    }
    if (t.length < 8) short += 1;
    if (/动画|帧|索引卡|精灵|sheet/i.test(t)) smell.push(n);
    if (/失败|错误|读不到|undefined|error|无描述/i.test(t)) err.push(n);
    dup.set(t, (dup.get(t) || 0) + 1);
  }
  const dups = [...dup.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
  say(`\n=== ${cat} ===`);
  say(`  items=${names.length} withText=${names.length - noText} noText=${noText} short(<8)=${short}`);
  say(`  animation-smell=${smell.length}` + (smell.length ? ' -> ' + smell.slice(0, 5).join(', ') : ''));
  say(`  error-smell=${err.length}` + (err.length ? ' -> ' + err.slice(0, 5).join(', ') : ''));
  say(`  duplicate-desc groups=${dups.length}` + (dups.length ? ` (max x${dups[0][1]})` : ''));
  say('  --- sample 10 ---');
  const step = Math.max(1, Math.floor(names.length / 10));
  for (let i = 0; i < names.length; i += step) {
    const n = names[i];
    say(`    ${n} : ${String(items[n]?.text ?? '(none)').slice(0, 90)}`);
  }
}

writeFileSync(OUT, LINES.join('\n'), 'utf8');
console.log('\n  details (UTF-8) -> ' + OUT);

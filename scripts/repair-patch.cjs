/**
 * 修复被写坏的 cordis.patch.yml：
 *   ① 用真实 YAML 解析器（profile 里的 js-yaml）找出**最后一份能解析的备份**；
 *   ② 以"当前文件（DSH 重置后的干净版）"为基底，把缺失的 id 行从那份备份里补回来；
 *   ③ 对结果**再解析一次**，通过才写盘。
 *
 * 为什么要用解析器而不是肉眼/正则：这次崩溃就是"多行值被写坏"引起的，
 * 而坏法（旧值尾巴残留）肉眼很容易漏。解析器是唯一可信的判据。
 */
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const PROFILE = 'C:/Users/Kishin/.dsh/profiles/desktop';
const PATCH = path.join(PROFILE, 'cordis.patch.yml');
// js-yaml 在 profile 的 node_modules 里（DSH 自带），借它来解析
const requireFromProfile = createRequire(path.join(PROFILE, 'noop.js'));
const YAML = requireFromProfile('js-yaml');

function parseOk(text) {
  try {
    const doc = YAML.load(text);
    return { ok: true, rows: Array.isArray(doc) ? doc.length : 0 };
  } catch (error) {
    return { ok: false, error: error.message.split('\n')[0] };
  }
}

const current = fs.readFileSync(PATCH, 'utf8');
console.log('当前文件解析:', JSON.stringify(parseOk(current)));

// ① 从新到旧找第一份能解析的备份
const backups = fs
  .readdirSync(PROFILE)
  .filter((n) => n.startsWith('cordis.patch.yml.bak-'))
  .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));

let source = null;
for (const name of backups) {
  const text = fs.readFileSync(path.join(PROFILE, name), 'utf8');
  const result = parseOk(text);
  console.log(`  ${name}: ${result.ok ? '可解析（' + result.rows + ' 条）' : '解析失败 → ' + result.error}`);
  if (result.ok && !source) source = { name, text, rows: result.rows };
  if (source && !result.ok) break; // 一旦遇到坏的就停（用第一份好的）
}
if (!source) {
  console.error('没有找到可解析的备份，放弃自动恢复');
  process.exit(1);
}
console.log('采用备份:', source.name, `（${source.rows} 条）`);

// ② 取缺失的 id 行（按备份里的原顺序）
const idOf = (row) => (row && typeof row === 'object' ? row.id : undefined);
const currentRows = YAML.load(current);
const have = new Set(currentRows.map(idOf));

const chunks = source.text.split(/(?=^- id: )/m);
const missing = chunks.filter((c) => {
  const id = (c.match(/^- id:\s*(\S+)/) || [])[1];
  return id && !have.has(id);
});
console.log(
  '缺失的行:',
  missing.map((c) => (c.match(/^- id:\s*(\S+)/) || [])[1]).join(', ') || '（无）',
);

if (!missing.length) {
  console.log('没有缺失的行，无需改动');
  process.exit(0);
}

let out = current.replace(/\s*$/, '\n');
for (const chunk of missing) {
  out += '\n' + chunk.replace(/\s*$/, '\n');
}

// ③ 结果必须能解析才写
const check = parseOk(out);
if (!check.ok) {
  console.error('❌ 重建结果无法解析，**不写盘**：', check.error);
  process.exit(2);
}
console.log('重建结果解析: OK（' + check.rows + ' 条）');

fs.copyFileSync(PATCH, PATCH + '.pre-restore-' + Date.now());
fs.writeFileSync(PATCH, out, 'utf8');
console.log('✅ 已写入，且已通过解析校验');

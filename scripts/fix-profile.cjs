/**
 * 把被"禁用第三方插件"动作摘掉的 bundle 加回 package.json，并把插件行指向最新入口。
 *
 * 背景：DSH 崩溃对话框里那个「禁用第三方插件、备份 profile patch 并重启」按钮会
 *   ① 把 cordis.patch.yml 里第三方插件的行删掉/重写；
 *   ② 把 package.json 的 dsh.profile.bundles 里对应项摘掉（否则它们还会被加载）。
 * 所以恢复配置时要**两处一起**恢复，只补 patch 是没用的（插件依然不会加载）。
 *
 * 安全措施：改完必须 JSON.parse 通过；bundles 只做"补齐"，不重排、不去重已有项。
 *   node scripts/fix-profile.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const PROFILE = 'C:/Users/Kishin/.dsh/profiles/desktop';
const PKG = path.join(PROFILE, 'package.json');

/** 需要确保在 bundles 里的包（顺序按这个列表补到末尾） */
const NEED = ['dsh-pet', 'dsh-game-pet-watch'];
const PACKAGE_DIR = path.join('G:', 'goh agent', 'dsh-game-pet-watch');
/**
 * 插件行的入口 = 包内**最新的** `index-<版本>.js`。不要写死版本号：
 * 曾经硬编码 0.3.6，结果每次跑都把刚 bump 出来的新入口改回旧版本 ——
 * 而版本化入口的意义正是"换 URL 绕开加载器的模块缓存"，指回旧名可能命中旧模块（改的代码不生效）。
 */
function newestEntry() {
  const files = fs
    .readdirSync(PACKAGE_DIR)
    .filter((n) => /^index-\d+\.\d+\.\d+\.js$/.test(n))
    .map((n) => ({ n, v: n.slice('index-'.length, -'.js'.length).split('.').map(Number) }))
    .sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return files.length ? 'dsh-game-pet-watch/' + files[0].n : null;
}
const ENTRY = newestEntry();
if (!ENTRY) {
  console.error('包内没有 index-<版本>.js，先跑 scripts/bump-entry.mjs');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
const bundles = pkg?.dsh?.profile?.bundles;
if (!Array.isArray(bundles)) {
  console.error('package.json 里没有 dsh.profile.bundles，未改动');
  process.exit(1);
}

const added = [];
for (const name of NEED) {
  if (!bundles.includes(name)) {
    bundles.push(name);
    added.push(name);
  }
}
console.log(added.length ? '已补回 bundles: ' + added.join(', ') : 'bundles 无需改动');

fs.copyFileSync(PKG, PKG + '.pre-fix-' + Date.now());
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
JSON.parse(fs.readFileSync(PKG, 'utf8')); // 复查能被解析
console.log('package.json 已写入并校验通过');
console.log('现在 bundles:', bundles.join(', '));

// ---- patch 里的入口改到最新版本（只改这一行，改完用 YAML 解析校验） ----
const { createRequire } = require('node:module');
const requireFromProfile = createRequire(path.join(PROFILE, 'noop.js'));
const YAML = requireFromProfile('js-yaml');
const PATCH = path.join(PROFILE, 'cordis.patch.yml');
const text = fs.readFileSync(PATCH, 'utf8');
const rows = YAML.load(text);
const row = rows.find((r) => r && r.id === 'game-pet-watch');
if (!row) {
  console.error('patch 里没有 game-pet-watch 行，未改入口');
  process.exit(1);
}
if (row.name === ENTRY) {
  console.log('入口已是最新:', ENTRY);
} else {
  const next = text.replace(
    /(- id: game-pet-watch\s*\n\s*name: )'[^']*'/,
    `$1'${ENTRY}'`,
  );
  try {
    const check = YAML.load(next);
    if (!Array.isArray(check) || check.length !== rows.length) throw new Error('条目数变化');
  } catch (error) {
    console.error('❌ 改入口后解析失败，不写盘：', error.message);
    process.exit(2);
  }
  fs.writeFileSync(PATCH, next, 'utf8');
  console.log(`入口: ${row.name} → ${ENTRY}（已校验）`);
}

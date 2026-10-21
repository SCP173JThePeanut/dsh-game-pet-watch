/**
 * 换代脚本：生成一个新的版本化宿主入口，并可顺手把 profile 的 patch 指过去。
 *
 *   node scripts/bump-entry.mjs 0.2.2
 *   node scripts/bump-entry.mjs 0.2.2 --patch C:\Users\Kishin\.dsh\profiles\desktop\cordis.patch.yml
 *
 * 为什么需要它：加载器按模块 URL 缓存已求值的模块，改 index.js 不会生效；
 * 换个入口文件名（= 换 URL）才会重新求值。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法： node scripts/bump-entry.mjs <x.y.z> [--patch <cordis.patch.yml 绝对路径>]');
  process.exit(2);
}

const entry = join(PACKAGE_ROOT, `index-${version}.js`);
const body = `/**
 * 版本化入口（当前代：${version}）。实现见 ./index.js —— 只有一份实现，本文件只做转发。
 *
 * 改代码后：node scripts/bump-entry.mjs <新版本> [--patch <profile 的 cordis.patch.yml>]
 * 加载器按模块 URL 缓存，所以必须换文件名才能让宿主重新求值。
 */
export * from './index.js';
`;
writeFileSync(entry, body, 'utf8');
console.log('已生成 ' + entry);

/**
 * **删掉旧版本入口**（规则：仓库里只留当前版本的 index-<x.y.z>.js）。
 * 只删形如 index-1.2.3.js 的文件，别的一律不碰。
 */
{
  let removed = 0;
  for (const file of readdirSync(PACKAGE_ROOT)) {
    if (!/^index-\d+\.\d+\.\d+\.js$/.test(file)) continue;
    if (file === `index-${version}.js`) continue;
    unlinkSync(join(PACKAGE_ROOT, file));
    removed += 1;
  }
  if (removed) console.log('已删旧入口 ' + removed + ' 个（仓库只留当前版本）');
}

/**
 * **把 package.json 的 files 里的入口名换成新的**（否则新入口不会被打进 tgz）。
 * 老版本这里写的是确切文件名，一 bump 就漏 —— 实测装出来的包缺 index-<新版>.js。
 */
{
  const pkgFile = join(PACKAGE_ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const nextEntry = `index-${version}.js`;
  const kept = files.filter((f) => !/^index-[^/]+\.js$/.test(f));
  kept.unshift(nextEntry);
  if (JSON.stringify(kept) !== JSON.stringify(files)) {
    pkg.files = kept;
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    console.log('已更新 package.json files 的入口：' + nextEntry);
  }
}

const patchFlag = process.argv.indexOf('--patch');
if (patchFlag !== -1) {
  const patchFile = process.argv[patchFlag + 1];
  if (!patchFile || !existsSync(patchFile)) {
    console.error('--patch 需要给出存在的 cordis.patch.yml 路径');
    process.exit(2);
  }
  const text = readFileSync(patchFile, 'utf8');
  // 分两步找：先定位我们那一行，再只改它下面第一条 name:（行尾注释也容忍）
  const lines = text.split('\n');
  const rowIndex = lines.findIndex((line) => /^\s*-\s*id:\s*game-pet-watch\s*$/.test(line));
  if (rowIndex === -1) {
    console.error('patch 里没找到 `- id: game-pet-watch` 那一行，没改');
    process.exit(1);
  }
  let nameIndex = -1;
  for (let i = rowIndex + 1; i < lines.length; i += 1) {
    if (/^\s*-\s/.test(lines[i])) break; // 到下一条目为止
    if (/^\s*name:\s*/.test(lines[i])) {
      nameIndex = i;
      break;
    }
  }
  if (nameIndex === -1) {
    console.error('patch 里那一行下面没有 name:，没改（可手工加：name: \'dsh-game-pet-watch/index-' + version + ".js'\")");
    process.exit(1);
  }
  lines[nameIndex] = lines[nameIndex].replace(/name:\s*.*$/, `name: 'dsh-game-pet-watch/index-${version}.js'`);
  const next = lines.join('\n');
  if (next === text) {
    console.error('patch 内容没有变化');
    process.exit(1);
  }
  writeFileSync(`${patchFile}.bak-${Date.now()}`, text, 'utf8');
  writeFileSync(patchFile, next, 'utf8');
  console.log('已把 patch 的 name 指向 index-' + version + '.js：' + patchFile);
}

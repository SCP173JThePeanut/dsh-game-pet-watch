// 配置写回的自检：拿真实 patch 文件的副本演练，确认只动目标行、别处一字不改。
// 用法： node tests/config-store.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { applyConfigToPatchText } from '../src/config-store.js';

const real = 'C:\\Users\\Kishin\\.dsh\\profiles\\desktop\\cordis.patch.yml';
/**
 * 真实文件现在**已经含**本插件那一行（界面写回装上去的），所以"还没有这一行"的基线要自己造：
 * 去掉 `- id: game-pet-watch` 那一行，以及紧跟其后的 config 段（缩进块）。
 */
const source = (() => {
  const lines = readFileSync(real, 'utf8').split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*-\s*id:\s*game-pet-watch\s*$/.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (/^\s+\S/.test(line)) continue; // 仍在被删条目的缩进块里
      skipping = false;
    }
    out.push(line);
  }
  return out.join('\n');
})();
assert.ok(!/game-pet-watch/.test(source), '测试基线里不该还有本插件的行');
const VALUES = {
  personality: '新的鱼设',
  rules: '只说人话',
  windowTitle: 'Dignitas',
  intervalSec: 33,
  pushToPet: false,
  compactEvery: 7,
};

// ---- 情形 A：patch 里还没有本插件的行（刚装完就是这样）→ 必须在文件末尾补一条覆盖行
const inserted = applyConfigToPatchText(source, VALUES);
assert.equal(inserted.error, undefined, '没有目标行时不该报错，应该走插入路径');
assert.ok(inserted.created, '应当报告 created');
assert.ok(inserted.text.includes('- id: game-pet-watch'), '没插入条目行');
assert.ok(!/id: game-pet-watch\n\s+name:/.test(inserted.text), '覆盖行不该带 name（会变成装两遍）');
assert.ok(inserted.text.includes("personality: '新的鱼设'"), 'personality 没写进去');
assert.ok(inserted.text.includes('pushToPet: false'), 'pushToPet 没写进去');
// 原有内容必须原样保留：新块只出现在末尾，前面一个字节都不差
const insertedLines = inserted.text.split('\n');
const blockStart = insertedLines.indexOf('- id: game-pet-watch');
assert.ok(blockStart > 0, '新块没找到');
assert.equal(
  insertedLines.slice(0, blockStart).join('\n').replace(/\n+$/, ''),
  source.replace(/\n+$/, ''),
  '原文件内容必须原样保留在前',
);
assert.equal(insertedLines.length - blockStart, 9, `新块行数不对：${insertedLines.length - blockStart}`);

// ---- 情形 B：已经有本插件的行（情形 A 的产物）→ 原地替换，不增删行
const replaced = applyConfigToPatchText(inserted.text, VALUES);
assert.equal(replaced.error, undefined);
assert.equal(replaced.created, false, '已有 config 段时不该报告 created');
assert.equal(replaced.text, inserted.text, '同值重写应当逐字不变（幂等）');
const changedTo = applyConfigToPatchText(inserted.text, { ...VALUES, intervalSec: 45, personality: "说'真话'的鱼" });
assert.ok(changedTo.text.includes('intervalSec: 45'), '替换没生效');
assert.ok(changedTo.text.includes("personality: '说''真话''的鱼'"), '单引号转义不对');
assert.equal(changedTo.text.split('\n').length, inserted.text.split('\n').length, '原地替换不该增减行数');
// changed 列的是"本次写进去的键"，不是"值真的变了的键"
assert.equal(changedTo.changed.sort().join(','), 'compactEvery,intervalSec,personality,pushToPet,rules,windowTitle');

// ---- 情形 C：文件里全是别人的行 → 追加我们的行，别人的内容一个字都不能动
const foreign = ['- id: someone-else', '  name: their-plugin', '  config:', '    keep: true', ''].join('\n');
const appended = applyConfigToPatchText(foreign, { personality: 'x' });
assert.equal(appended.error, undefined);
assert.ok(appended.text.startsWith(foreign.replace(/\n$/, '')), '别人的内容必须原样在前');
assert.ok(appended.text.includes('- id: game-pet-watch'), '我们的行没追加');
assert.ok(appended.text.includes("personality: 'x'"), '值没写进去');

// ---- 情形 D：真实写盘（临时目录，不碰用户 profile），备份必须等于原文
const dir = mkdtempSync(join(tmpdir(), 'gpw-patch-'));
const file = join(dir, 'cordis.patch.yml');
writeFileSync(file, source, 'utf8');
process.env.DSH_PROFILE_DIR = dir;
const { writeConfigToProfile } = await import('../src/config-store.js');
const result = await writeConfigToProfile({ personality: '写盘演练', intervalSec: 42 });
assert.equal(result.ok, true, '写盘应当成功：' + JSON.stringify(result));
const after = readFileSync(file, 'utf8');
assert.ok(after.includes("personality: '写盘演练'"), '写盘后没看到新值');
assert.ok(result.backup && readFileSync(result.backup, 'utf8') === source, '备份内容应当等于原文');
// 白名单之外的键不许被界面写进去
const filtered = await writeConfigToProfile({ evil: 'x', personality: '白名单' });
assert.equal(filtered.changed.join(','), 'personality', 'EDITABLE_KEYS 白名单没生效：' + filtered.changed.join(','));

console.log('config-store 自检全部通过（A 追加 / B 原地替换+幂等 / C 不动别人的行 / D 写盘+备份+白名单）');

/**
 * 回归测试：**多行值替换不能把 patch 写坏**。
 *
 * 背景（真实事故）：提示词是多行文本，写作单引号跨行标量。旧实现替换时只改「key: …」那一行，
 * 旧值的续行留在原地 → 新值闭合后多出几行裸文本 → YAML 解析失败 →
 * **DSH 整个起不来**（DesktopHostFatalError: failed to parse overlay）。
 *
 * 所以这里必须用**真正的 YAML 解析器**验证结果（profile 的 node_modules 里有 js-yaml），
 * 而不是比字符串 —— 那次就是因为只比字符串才漏过去的。
 *
 *   node tests/multiline.test.mjs
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { applyConfigToPatchText } from '../src/config-store.js';

const PROFILE = 'C:/Users/Kishin/.dsh/profiles/desktop';
const requireFromProfile = createRequire(join(PROFILE, 'noop.js'));
const YAML = requireFromProfile('js-yaml');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
};

const BEFORE = [
  '# patch',
  '- id: ui-chat',
  '  config:',
  '    transcriptView: standard',
  '- id: game-pet-watch',
  "  name: 'dsh-game-pet-watch/index-0.3.6.js'",
  '  config:',
  '    enabled: true',
  "    personality: '旧人设第一行",
  '旧人设第二行',
  "旧人设第三行'",
  "    rules: '旧规则第一行",
  '旧规则第二行',
  "旧规则第三行'",
  '    maxChars: 60',
  '',
].join('\n');

const NEW_RULES = '新规则第一行\n新规则第二行\n新规则第三行\n新规则第四行';
const NEW_PERSONALITY = '新人设只有一行';

console.log('=== 多行值替换 ===');
const result = applyConfigToPatchText(BEFORE, { rules: NEW_RULES, personality: NEW_PERSONALITY });
const out = result.text;

// ① 旧值续行必须被清掉
check('旧 rules 续行已消失', !out.includes('旧规则第二行') && !out.includes('旧规则第三行'));
check('旧 personality 续行已消失', !out.includes('旧人设第二行') && !out.includes('旧人设第三行'));

// ② 结果必须能被真解析器解析，且值正确（这是关键判据）
let parsed;
try {
  parsed = YAML.load(out);
  check('结果可被 YAML 解析', true);
} catch (error) {
  check('结果可被 YAML 解析', false, '→ ' + error.message.split('\n')[0]);
}
if (parsed) {
  const row = parsed.find((r) => r && r.id === 'game-pet-watch');
  check('条目数不变（2 条）', parsed.length === 2, `实际 ${parsed.length}`);
  check('rules 值等于新值且**换行保留**', row?.config?.rules === NEW_RULES, JSON.stringify(row?.config?.rules));
  check('personality 值等于新值', row?.config?.personality === NEW_PERSONALITY);
  check('未动的键仍保留（maxChars=60）', row?.config?.maxChars === 60);
  check('别的条目未被破坏', parsed.find((r) => r?.id === 'ui-chat')?.config?.transcriptView === 'standard');
}

// ③ 幂等：再写一次同样的值不应改变内容
const again = applyConfigToPatchText(out, { rules: NEW_RULES, personality: NEW_PERSONALITY });
check('同值重写内容不变（幂等）', again.text === out);

// ④ 真实文件演练：拿当前 profile 的 patch 走一遍"多行值替换 + 解析"，但**不落盘**
console.log('=== 真实 patch 演练（只算不写）===');
const fs = await import('node:fs');
const realText = fs.readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8');
const realOut = applyConfigToPatchText(realText, {
  rules: '演练A\n演练B\n演练C',
  compactSystem: '压A\n压B',
}).text;
try {
  const realParsed = YAML.load(realOut);
  const rows = YAML.load(realText);
  const row = realParsed.find((r) => r?.id === 'game-pet-watch');
  check('真实 patch 替换后仍可解析', true, `条目 ${Array.isArray(realParsed) ? realParsed.length : '?'}`);
  check('真实 patch 条目数不变', Array.isArray(realParsed) && realParsed.length === rows.length);
  check('真实 patch 新值正确', row?.config?.rules === '演练A\n演练B\n演练C');
} catch (error) {
  check('真实 patch 替换后仍可解析', false, '→ ' + error.message.split('\n')[0]);
}

console.log('');
console.log(failed ? `❌ ${failed} 项失败` : '✅ 全部通过');
process.exit(failed ? 1 : 0);

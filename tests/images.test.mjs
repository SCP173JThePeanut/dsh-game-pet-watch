/**
 * 表情包目录自检（`node tests/images.test.mjs`）。
 *
 * 覆盖的都是"错了会静默坏掉"的地方：
 *   ① JSONC 解析必须吃得下**行尾注释** —— 原版 config.jsonc 有 163 处 `//`，
 *      正则版曾整个解析失败，27 张表情包的描述全丢（模型于是没图可挑）；
 *   ② 目录链去重：同名图以用户目录为准（包内图不该覆盖用户自己换的那张）；
 *   ③ 同步只补缺：已有条目（尤其人工改过的）不被覆盖，重复跑结果稳定；
 *   ④ 名字校验：目录外的名字不产生配图（防模型幻觉出图外的名字 → 气泡图裂）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../src/catalog.js';
import {
  parseJsonc,
  scanMemes,
  syncImageCatalog,
  imagePromptBlock,
  memesDirs,
  readPackageMemes,
  readScrapedDescriptions,
} from '../src/images.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
};

const root = mkdtempSync(join(tmpdir(), 'gpw-images-'));
const userRoot = join(root, 'user');
const upstream = join(root, 'upstream');
mkdirSync(join(userRoot, 'memes'), { recursive: true });
mkdirSync(join(upstream, 'assets', 'memes'), { recursive: true });

// ① JSONC：行尾注释 + 字符串里的 // + 块注释 + 尾逗号
console.log('=== JSONC 解析 ===');
const jsonc = `{
  // 行首注释
  "a": 1,          // 行尾注释
  "url": "https://example.com/x//y",
  "text": "含 // 双斜杠的字符串",
  /* 块注释 */
  "memes": { "图一": "描述一", "图二": "描述二" },
}`;
try {
  const parsed = parseJsonc(jsonc);
  check('能吃行尾注释与块注释', parsed.a === 1 && parsed.memes['图二'] === '描述二');
  check('不误删字符串里的 //', parsed.url === 'https://example.com/x//y' && parsed.text === '含 // 双斜杠的字符串');
} catch (error) {
  check('JSONC 解析', false, '→ ' + error.message.split('\n')[0]);
}

// ② 目录链与同名去重
console.log('=== 扫描与去重 ===');
writeFileSync(join(upstream, 'assets', 'memes', '同名.png'), 'x');
writeFileSync(join(upstream, 'assets', 'memes', '只有包内有.png'), 'x');
writeFileSync(join(userRoot, 'memes', '同名.png'), 'x');
writeFileSync(join(userRoot, 'memes', '用户加的.png'), 'x');
writeFileSync(join(userRoot, 'memes', '也收我.webp'), 'x');   // webp 要收（站上抓来的只有 webp）
writeFileSync(join(userRoot, 'memes', '忽略我.jpg'), 'x');   // 其它扩展名仍然忽略
const dirs = memesDirs(userRoot, upstream);
const scanned = scanMemes(dirs);
check('收 .png 与 .webp', scanned.some((x) => x.name === '也收我') && scanned.some((x) => x.name === '只有包内有'));
check('忽略其它扩展名', !scanned.some((x) => x.name === '忽略我'), `共 ${scanned.length} 张`);
check('同名以用户目录为准', scanned.find((x) => x.name === '同名')?.dir === dirs[0]);
check('包内独有的仍在', scanned.some((x) => x.name === '只有包内有'));

// ③ 描述来源：包内表 + 抓取台词表
console.log('=== 描述来源 ===');
writeFileSync(join(upstream, 'assets', 'config.jsonc'), '{\n  "memes": { "只有包内有": "包内描述" }, // 注释\n}');
writeFileSync(join(userRoot, 'memes', 'descriptions.json'), JSON.stringify({ '用户加的': '抓来的台词' }));
const pkg = readPackageMemes(upstream);
const scraped = readScrapedDescriptions(userRoot);
check('读到包内描述表', pkg['只有包内有'] === '包内描述');
check('读到抓取台词表', scraped['用户加的'] === '抓来的台词');

// ④ 同步：离线描述直填、只补缺、幂等
console.log('=== 同步 ===');
const store = new CatalogStore({ file: join(root, 'catalog.json'), describe: async () => ({ raw: '{}' }), log: () => {} });
let describeCalls = 0;
const result = await syncImageCatalog({
  store,
  dirs,
  descriptions: { ...pkg, ...scraped },
  describe: async ({ name }) => {
    describeCalls += 1;
    store.data.items[name] = { at: Date.now(), text: '视觉描述：' + name };
  },
  log: () => {},
});
check('有描述的不调视觉模型', describeCalls === 2, `describe 调用 ${describeCalls} 次（"同名"与"也收我"缺描述）`);
check('描述直填正确', store.item('只有包内有')?.text === '包内描述' && store.item('用户加的')?.text === '抓来的台词');
check('缺描述的走了视觉通道', store.item('同名')?.text === '视觉描述：同名');
check('同步结果计数', result.total === 4 && result.added === 2 && result.described === 2, JSON.stringify(result));

store.data.items['只有包内有'].text = '人工改过';
const again = await syncImageCatalog({ store, dirs, descriptions: { '只有包内有': '不该覆盖' }, log: () => {} });
check('重复同步不覆盖已有条目', store.item('只有包内有')?.text === '人工改过', `第二次 added=${again.added}`);

// ⑤ 提示词块与名字校验
console.log('=== 提示词与校验 ===');
const block = imagePromptBlock(store);
check('清单带名字与描述', block.includes('只有包内有：包内描述') || block.includes('只有包内有：人工改过'));
check('清单说明怎么用', block.includes('img'));
check('目录外名字不认', store.item('不存在.jpg') === undefined);

rmSync(root, { recursive: true, force: true });
console.log('');
console.log(failed ? `❌ ${failed} 项失败` : '✅ 全部通过');
process.exit(failed ? 1 : 0);

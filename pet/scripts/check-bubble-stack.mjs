/**
 * 气泡堆叠自检（`node scripts/check-bubble-stack.mjs`）—— 静态检查三处改动是否配套。
 *
 * 用户要求：短时间多条消息**不要互相覆盖**，旧的显示在新的上面。
 * 这涉及三个文件，少一处就会出现"还是不堆叠"或者"行叠在一起没有分隔"：
 *   ① events.js     —— 维护 `whisperStack`（每条自带 until，各自到期；上限 3 条）
 *   ② sprite.js     —— 把 stack 渲染成多行（旧的在上、新的在下，旧的淡化）
 *   ③ shared-core.js —— 行间距与淡化样式（.pet-bub-line / .is-old / .is-older）
 *
 * 为什么写成脚本而不是单元测试：这三处跨了"事件层/渲染层/样式层"，
 * 单个文件能语法通过但配套断了（例如 stack 建了但渲染层没读）—— 只有对着三份文件一起查才看得出。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'runtime/electron-helper-copy';
const read = (f) => readFileSync(join(dir, f), 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
};

const events = read('events.js');
const sprite = read('sprite.js');
const shared = read('shared-core.js');

console.log('目录: ' + dir);

console.log('=== ① 事件层：入栈 / 独立过期 / 上限 ===');
check('有 whisperStack 入栈', /this\.whisperStack\.push\(/.test(events));
check('每条带自己的 until（独立过期）', /until:\s*now \+ WHISPER_LINE_MS/.test(events));
check('有剪枝函数', /pruneWhisperStack/.test(events));
check('用 interval 统一剪枝（不再 clearTimeout 掉旧的）', /setInterval\(\(\) => \{\s*if \(this\.pruneWhisperStack\(\)\)/.test(events));
check('有条数上限', /WHISPER_STACK_MAX\s*=\s*\d+/.test(events));
check('全部过期才收起（whisperOn = false 在剪枝里）', /kept\.length[\s\S]{0,120}this\.whisperOn = false/.test(events));

console.log('=== ② 渲染层：把 stack 画成多行（旧的上、新的下）===');
check('读取 whisperStack', /this\.whisperStack/.test(sprite));
check('用 pet-bub-line 逐行渲染', /pet-bub-line/.test(sprite));
check('越旧的越淡（is-old / is-older）', /is-old/.test(sprite) && /is-older/.test(sprite));
check('没有 stack 时退化成单行（兼容旧路径）', /this\.whisperView\[0\]\?\.text/.test(sprite));

console.log('=== ③ 样式层：行距与淡化 ===');
check('有 .pet-bub-line+.pet-bub-line 间距', /\.pet-bub-line\+\.pet-bub-line\{margin-top/.test(shared.replace(/\s+/g, '')));
check('有 .is-old 淡化', /\.pet-bub-line\.is-old\{opacity/.test(shared.replace(/\s+/g, '')));
check('有 .is-older 更淡', /\.pet-bub-line\.is-older\{opacity/.test(shared.replace(/\s+/g, '')));

console.log('=== ④ 不能把"覆盖"的旧逻辑留着 ===');
check('旧的 setTimeout(BUBBLE_DURATION_MS) 展示路径已移除（否则仍会覆盖）', !/this\.whisperTimer = window\.setTimeout/.test(events));

console.log('');
console.log(failed ? `❌ ${failed} 项失败` : '✅ 全部通过');
process.exit(failed ? 1 : 0);

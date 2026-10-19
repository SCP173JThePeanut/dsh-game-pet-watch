/**
 * 看/导出桌宠发出去的**原始请求**（`node scripts/show-last-request.mjs [--print] [--out 文件]`）。
 *
 * 数据来源：插件在 `ctx.llm.stream()` 处抓的 `<数据目录>/last-request-<鱼的id>.json` ✓
 * （provider / model / system / messages / tools ✓ —— 一手材料，不是事后重演的 ✓）。
 *
 * ⚠️ 控制台**只打 ASCII** ✓：Windows 控制台是 GBK ✗，中文打上去就乱码 ✓；
 *    中文内容一律写进 UTF-8 文件，用 VS Code / 记事本打开 ✓。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join('C:/Users/Kishin/.dsh/game-pet-watch');
const OUT_DIR = 'G:/goh agent';

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1] ?? '';
};
const want = argOf('--fish', '');
const FILE = join(DIR, want ? `last-request-${want}.json` : 'last-request.json');

if (!existsSync(FILE)) {
  console.log('no capture yet: ' + FILE);
  console.log('  plugin 0.7.63+ writes it on every model call; per-fish files: last-request-<id>.json');
  process.exit(0);
}

const raw = readFileSync(FILE, 'utf8');
const req = JSON.parse(raw);

if (argOf('--out')) {
  writeFileSync(argOf('--out'), raw, 'utf8');
  console.log('exported: ' + argOf('--out') + '  (' + raw.length + ' bytes)');
  process.exit(0);
}

const system = String(req.system ?? '');
const messages = req.messages ?? [];
const tag = String(req.fish || want || 'last').replace(/[^\w.-]+/g, '_');
const sysOut = join(OUT_DIR, `system-prompt-${tag}.txt`);
const reqOut = join(OUT_DIR, `pet-request-${tag}.json`);
writeFileSync(sysOut, system, 'utf8');
writeFileSync(reqOut, raw, 'utf8');
if (argv.includes('--print')) process.stdout.write(system + '\n');

const d = new Date(req.at);
const p = (x) => String(x).padStart(2, '0');
const time = Number.isNaN(d.getTime())
  ? String(req.at)
  : `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;

console.log('=== last request ===');
console.log('  time           : ' + time);
console.log('  fish           : ' + (req.fish || '(default)'));
console.log('  model          : ' + (req.route?.provider ?? '?') + ' / ' + (req.route?.model ?? '?'));
console.log('  system         : ' + system.length + ' chars');
console.log('  tools          : ' + ((req.tools ?? []).map((t) => t?.name ?? '?').join(', ') || '(none)'));
console.log('  messages       : ' + messages.length);
for (const [i, m] of messages.entries()) {
  const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
  const kinds = parts.map((x) => (x?.type === 'image' ? 'image' : 'text')).join('+');
  const len = parts.reduce((n, x) => n + (x?.type === 'text' ? String(x.text ?? '').length : 0), 0);
  console.log(`    [${i}] ${m.role}  ${kinds}  text ${len} chars`);
}
console.log('  has_meme_block : ' + system.includes('<meme_library>'));
console.log('  has_persona    : ' + system.includes('PERSONA_LOAD'));
console.log('  has_memory     : ' + system.includes('长期记忆'));
console.log('');
console.log('  UTF-8 files (open these, not the console):');
console.log('    system prompt : ' + sysOut);
console.log('    full request  : ' + reqOut);

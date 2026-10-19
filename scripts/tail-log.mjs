/**
 * 看插件日志（`node scripts/tail-log.mjs [--n 60] [--grep 关键词] [--follow] [--all]`）。
 *
 * 为什么需要这个脚本：插件的日志有两个去处，**都不好直接用** ✗
 *   ① 内存环形缓冲（`/state.diagnostics.logRing`，只有 25 条 ✓，被鱼板轮询刷得飞快 ✗）
 *   ② DSH 控制台（`~/.dsh/electron/debug.log` 里**没有**插件行 ✗）
 * 所以插件把日志同时写进 `<数据目录>/plugin.log` ✓，这个脚本负责**可读地**打印它 ✓。
 *
 * ⚠️ Windows 控制台是 GBK ✗ → 只打 ASCII ✓，中文原样输出（VS Code 里看 ✓）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FILE = join('C:/Users/Kishin/.dsh/game-pet-watch', 'plugin.log');
const OLD = `${FILE}.1`;

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1];
};
const n = Number(argOf('--n', '60')) || 60;
const grep = argOf('--grep', '') || '';
const follow = argv.includes('--follow');
const showAll = argv.includes('--all');

/** 默认滤掉的噪音（心跳/轮询 ✓） */
const NOISE = /对家文件|历史日志 \+|自己文件：自己进程记录|heartbeat/;

function humanTime(line) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s([\s\S]*)$/);
  if (!m) return line;
  const d = new Date(m[1]);
  if (Number.isNaN(d.getTime())) return line;
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${m[2]}`;
}

function readTail(file, lines) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-lines);
}

function keep(line) {
  if (grep && !line.includes(grep)) return false;
  if (!showAll && !grep && NOISE.test(line)) return false;
  return true;
}

function render() {
  const parts = [...readTail(OLD, Math.floor(n / 2)), ...readTail(FILE, n)];
  const rows = parts.filter(keep).slice(-n);
  console.log(`\n=== plugin.log (last ${rows.length}${grep ? `, grep "${grep}"` : ''}) ===`);
  for (const l of rows) console.log(humanTime(l));
  console.log(`\n  full file: ${FILE}`);
}

if (!existsSync(FILE) && !existsSync(OLD)) {
  console.log('no log yet: ' + FILE);
  console.log('  the plugin creates it on its next start/write.');
  process.exit(0);
}

render();

if (follow) {
  let size = 0;
  try {
    size = statSync(FILE).size;
  } catch {
    /* ignore */
  }
  console.log('\n  following... (Ctrl+C to stop)');
  setInterval(() => {
    try {
      const now = statSync(FILE).size;
      if (now < size) {
        size = 0; // rotated
        return;
      }
      if (now === size) return;
      const chunk = readFileSync(FILE, 'utf8').slice(size);
      size = now;
      for (const l of chunk.split('\n').filter(Boolean)) if (keep(l)) console.log(humanTime(l));
    } catch {
      /* ignore */
    }
  }, 1000);
}

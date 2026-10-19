// 批量压测抽帧台：把每段动画都过一遍，报告成功/失败、耗时、缓存命中。
//   node scripts/sheet-sweep.mjs [--port 7341] [--limit 0]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = argOf('--port', '7341');
const LIMIT = Number(argOf('--limit', '0'));
const BASE = `http://127.0.0.1:${PORT}`;

const assets = await (await fetch(`${BASE}/gpw/assets`)).json();
if (!assets?.ok) {
  console.error('拿不到素材清单：' + JSON.stringify(assets).slice(0, 200));
  process.exit(1);
}
let files = assets.files;
if (LIMIT > 0) files = files.slice(0, LIMIT);
console.log(`压测 ${files.length} 段动画（端口 ${PORT}）…`);

const results = [];
let fail = 0;
for (const [index, file] of files.entries()) {
  const started = Date.now();
  let line;
  try {
    const res = await fetch(`${BASE}/gpw/sheet?file=${encodeURIComponent(file.file)}&cols=4&rows=3&tileW=320`, {
      signal: AbortSignal.timeout(120000),
    });
    const body = await res.json();
    const ms = Date.now() - started;
    if (body?.ok) {
      line = { file: file.file, ok: true, ms, frames: body.meta?.frames?.length ?? 0, cached: body.cached === true, sheet: body.sheet };
    } else {
      fail += 1;
      line = { file: file.file, ok: false, ms, error: body?.error ?? `HTTP ${res.status}` };
    }
  } catch (error) {
    fail += 1;
    line = { file: file.file, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) };
  }
  results.push(line);
  const mark = line.ok ? (line.cached ? '=' : '+') : '×';
  process.stdout.write(`${mark} ${String(index + 1).padStart(3)}/${files.length} ${file.file} ${line.ms}ms${line.ok ? '' : ' → ' + line.error}\n`);
}

const dir = join(homedir(), '.dsh', 'dsh-pet-gpw');
mkdirSync(dir, { recursive: true });
const report = join(dir, 'sheet-sweep.json');
writeFileSync(report, JSON.stringify({ at: Date.now(), total: results.length, failed: fail, results }, null, 2), 'utf8');

const ok = results.filter((r) => r.ok);
const uncached = ok.filter((r) => !r.cached);
const avg = (list) => (list.length ? Math.round(list.reduce((s, r) => s + r.ms, 0) / list.length) : 0);
console.log('');
console.log(`成功 ${ok.length} / 失败 ${fail}`);
console.log(`首次解码均耗时 ${avg(uncached)}ms；缓存命中 ${ok.length - uncached.length} 段（均 ${avg(ok.filter((r) => r.cached))}ms）`);
if (fail) {
  console.log('失败清单：');
  for (const r of results.filter((r) => !r.ok)) console.log('  × ' + r.file + ' → ' + r.error);
}
console.log('报告：' + report);

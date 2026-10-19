// 解开 DSH 的会话日志（zstd，多帧串联）并统计"带图 vs 纯文本"请求的真实 input token。
//
// 用法： node scripts/session-usage.mjs <session.v4.jsonl.zstd>
//
// 为什么用流式：zstdDecompressSync 只解**第一帧**（拿到的会是那条 193 字节的 session 头），
// 日志是边写边压的多帧文件，必须用 createZstdDecompress 把所有帧串起来读。
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

const file = process.argv[2];
if (!file) {
  console.error('用法： node session-usage.mjs <session.v4.jsonl.zstd>');
  process.exit(2);
}

const raw = readFileSync(file);
const text = await new Promise((resolve, reject) => {
  const chunks = [];
  const dec = zlib.createZstdDecompress();
  dec.on('data', (c) => chunks.push(c));
  dec.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  dec.on('error', (error) => {
    // 尾部半帧：把已经解出来的交出去，不要整份丢掉
    if (chunks.length) resolve(Buffer.concat(chunks).toString('utf8'));
    else reject(error);
  });
  Readable.from([raw]).pipe(dec);
});

const lines = text.split('\n').filter((line) => line.trim());
console.log(`解压后 ${text.length} 字符 / ${lines.length} 条事件`);

const counts = new Map();
/** @type {{seq:number,type:string,hasImage:boolean,usage:any,bytes:number}[]} */
const rows = [];
let seq = 0;
for (const line of lines) {
  seq += 1;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    continue;
  }
  const type = ev.type ?? ev.kind ?? '?';
  counts.set(type, (counts.get(type) ?? 0) + 1);
  const blob = JSON.stringify(ev);
  const hasImage = blob.includes('"image"');
  const usage =
    ev.usage ??
    ev.data?.usage ??
    ev.message?.usage ??
    ev.request?.usage ??
    (ev.data?.message ? ev.data.message.usage : undefined);
  if (hasImage || /request/i.test(type)) rows.push({ seq, type, hasImage, usage, bytes: blob.length });
}

console.log('--- 事件类型（前 15）---');
for (const [type, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${type}: ${n}`);

const img = rows.filter((r) => r.hasImage);
const txt = rows.filter((r) => !r.hasImage && /request/i.test(r.type));
const fmt = (r) =>
  `seq ${r.seq} ${r.type} bytes=${r.bytes} usage=${JSON.stringify(r.usage ?? null)}`;
console.log(`--- 带图片的事件 ${img.length} 条 ---`);
for (const r of img.slice(-8)) console.log('  ' + fmt(r));
console.log(`--- 请求类事件（不带图）${txt.length} 条 ---`);
for (const r of txt.slice(-5)) console.log('  ' + fmt(r));

// 兜底：整份日志里搜带有 token 计数的字段
const usageHits = [...text.matchAll(/"inputTokens":\s*(\d+)[^}]*"outputTokens":\s*(\d+)/g)].slice(-6);
console.log('--- 日志里最后几条 inputTokens/outputTokens ---');
for (const hit of usageHits) console.log(`  input=${hit[1]} output=${hit[2]}`);

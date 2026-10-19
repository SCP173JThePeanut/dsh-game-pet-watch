// 会话 token 账本：把投影缓存里的 tokenUsage 打平，看累计、最近一步、以及每步的桶。
//
//   node scripts/token-audit.mjs [路径.json]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dir = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
const file =
  process.argv[2] ??
  readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((p) => p.endsWith('.json'))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

const doc = JSON.parse(readFileSync(file, 'utf8'));
const usage = doc?.record?.rows?.tokenUsage?.val ?? {};
console.log('会话文件：' + file.split(/[\\/]/).slice(-1)[0]);
console.log('');
console.log('=== 累计（整个会话）===');
for (const [key, value] of Object.entries(usage.totals ?? {})) {
  console.log(`  ${key}: ${Number(value).toLocaleString()}`);
}
console.log('');
console.log('=== 最近一步 ===');
if (usage.last) {
  console.log(`  turn ${usage.last.turn} / step ${usage.last.step}`);
  for (const [key, value] of Object.entries(usage.last.buckets ?? {})) {
    console.log(`    ${key}: ${Number(value).toLocaleString()}`);
  }
}
console.log('');
console.log('=== 历史中的其它键 ===');
for (const key of Object.keys(usage)) {
  if (key === 'totals' || key === 'last') console.log('  ' + key + ': ' + JSON.stringify(usage[key]).slice(0, 400));
}
console.log('');
const t = usage.totals ?? {};
const cacheHit = t.cacheReadTokens ?? 0;
const uncached = t.uncachedInputTokens ?? 0;
const totalIn = cacheHit + uncached;
if (totalIn > 0) {
  console.log('=== 缓存命中率 ===');
  console.log(`  输入合计 ${totalIn.toLocaleString()}，其中命中缓存 ${cacheHit.toLocaleString()}（${((cacheHit / totalIn) * 100).toFixed(1)}%），未命中 ${uncached.toLocaleString()}`);
  console.log('  → 命中缓存的部分按缓存单价计费（DeepSeek 系通常约为未命中的 1/10），所以"可缓存"的输入几乎免费');
}

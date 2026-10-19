/**
 * 从会话日志里统计"实际用过的 provider/model"——找工作那条路由。
 *   node .which-provider.mjs
 * 只读 ✓（zstd 解压后正则统计 ✓ 不打印任何密钥 ✗）。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ROOT = 'C:/Users/Kishin/.dsh/sessions';

function* walk(dir, depth = 0) {
  if (depth > 2) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(p, depth + 1);
    else if (name.endsWith('.zstd')) yield { path: p, mtime: st.mtimeMs, size: st.size };
  }
}

const files = [...walk(ROOT)].sort((a, b) => b.mtime - a.mtime).slice(0, 6);
console.log('newest session logs:', files.length);
for (const f of files) {
  let text = '';
  try {
    text = zstdDecompressSync(readFileSync(f.path)).toString('utf8');
  } catch (error) {
    console.log('  (skip, zstd fail)', f.path, String(error.message).slice(0, 60));
    continue;
  }
  const providers = new Map();
  const models = new Map();
  for (const m of text.matchAll(/"provider"\s*:\s*"([^"]+)"/g)) {
    providers.set(m[1], (providers.get(m[1]) ?? 0) + 1);
  }
  for (const m of text.matchAll(/"model"\s*:\s*"([^"]{2,40})"/g)) {
    models.set(m[1], (models.get(m[1]) ?? 0) + 1);
  }
  const rel = f.path.replace(/\\/g, '/').split('/').slice(-3).join('/');
  console.log('\n=== ' + rel + '  (' + Math.round(f.size / 1024) + ' KB, ' + new Date(f.mtime).toLocaleString() + ')');
  console.log('  providers:', [...providers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join(', ') || '(none)');
  console.log('  models   :', [...models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`).join(', ') || '(none)');
}

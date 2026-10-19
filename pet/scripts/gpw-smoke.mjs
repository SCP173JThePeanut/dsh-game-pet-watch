/**
 * 副本接口冒烟检查（`node scripts/gpw-smoke.mjs [--base http://127.0.0.1:7341]`）
 *
 * 为什么需要：插件侧有 `preflight.mjs`（会真打一遍路由），副本侧一直没有 ——
 * 结果出现了"只在请求进来时才炸"的错误（例如新路由里写了不存在的 `readJson`），
 * 而语法检查完全看不出来。这个脚本把副本的每个接口真调一遍，看响应是不是正常 JSON。
 *
 * 只做**读取 + 幂等**的调用；写操作（推话/改名）用无害的内容，并会检查返回。
 */
const BASE = (process.argv.find((a) => a.startsWith('--base='))?.split('=')[1] ?? 'http://127.0.0.1:7341').replace(/\/$/, '');

let failed = 0;
const ok = (m) => console.log('  ✅ ' + m);
const bad = (m, extra = '') => {
  console.log('  ❌ ' + m + (extra ? '  ' + extra : ''));
  failed += 1;
};

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（图片等）也算正常，由调用方判断 */
  }
  return { status: res.status, text, json, type: res.headers.get('content-type') ?? '' };
}

const checkJson = (label, r, extra = () => true) => {
  if (r.status >= 400) return bad(`${label} → HTTP ${r.status}`, r.text.slice(0, 120));
  if (!r.json) return bad(`${label} → 不是 JSON`, r.text.slice(0, 80));
  if (r.json.error) return bad(`${label} → 报错：${String(r.json.error).slice(0, 120)}`);
  if (!extra(r.json)) return bad(`${label} → 结构不对`, JSON.stringify(r.json).slice(0, 120));
  ok(`${label} → 200`);
};

console.log('副本冒烟检查：' + BASE);

console.log('=== 只读接口 ===');
/** 前缀判断：fish-board/1、/2 都算 ✓（同机两套 fork 不可能同时升级；v1→v2 是纯加法） */
checkJson('GET /gpw/brand', await call('GET', '/gpw/brand'), (j) => String(j.protocol || '').startsWith('fish-board/') && Number.isFinite(j.port));
checkJson('GET /gpw/state', await call('GET', '/gpw/state'), (j) => typeof j === 'object');
checkJson('GET /gpw/log', await call('GET', '/gpw/log?limit=5'), (j) => Array.isArray(j.entries));
checkJson('GET /gpw/prefs', await call('GET', '/gpw/prefs'));
// 真实存在的资源路由是 /dsh-pet-7340/config 与 /state（不是 /pets，我第一版猜错了）
checkJson('GET /dsh-pet-7340/config', await call('GET', '/dsh-pet-7340/config'), (j) => typeof j === 'object');
checkJson('GET /dsh-pet-7340/state', await call('GET', '/dsh-pet-7340/state'), (j) => typeof j === 'object');

console.log('=== 主人的话（共享广播通道，本次新加）===');
const text = `冒烟检查 ${new Date().toTimeString().slice(0, 8)}`;
const master = await call('POST', '/gpw/master', { text, to: '*' });
checkJson('POST /gpw/master', master, (j) => j.ok === true && j.to === '*');
const after = await call('GET', '/gpw/log?limit=3');
const found = (after.json?.entries ?? []).find((e) => e.text === text);
if (found) {
  ok(`主人的话进了共享记录（who=${found.who} to=${found.to}）`);
  if (found.who !== '主人') bad('who 必须是「主人」——接收端靠它判断说话者，不能按来源端口推断');
  if (found.to !== '*') bad('to 必须保留（全体/具体名字）');
} else {
  bad('主人的话没出现在 /gpw/log 里');
}

console.log('');
console.log(failed ? `❌ ${failed} 项失败` : '✅ 全部通过');
process.exit(failed ? 1 : 0);

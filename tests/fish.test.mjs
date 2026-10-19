/**
 * `src/fish.js` 的单测（纯函数 ✓ 不碰 IO ✓ 秒级 ✓）。
 *   node tests/fish.test.mjs
 */
import {
  normalizeOrigin, portOf, originOfPort, scopeOf, profileOf,
  findFish, fishByPort, primaryFish, defaultFish, enabledFish,
  freePort, uniqueFishId, makeFish, summarize, qqOf, maskSecret,
} from '../src/fish.js';

let pass = 0;
const fails = [];
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass += 1;
  else fails.push(`${label}: got ${a} want ${b}`);
}
function ok(cond, label) {
  if (cond) pass += 1;
  else fails.push(`${label}: expected truthy`);
}

const PETS = [
  { id: 'legacy', name: '鱼板妹妹7341', origin: 'http://127.0.0.1:7341', scope: 'legacy', enabled: true, qq: false, profile: '' },
  { id: 'current', name: '鱼板妹妹7342', origin: 'http://127.0.0.1:7342/', scope: 'current', enabled: true, qq: true, profile: 'second' },
];

// ── 端口 ──
eq(normalizeOrigin('  http://127.0.0.1:7341/  '), 'http://127.0.0.1:7341', 'normalizeOrigin trims + strips slash');
eq(normalizeOrigin(''), '', 'normalizeOrigin empty');
eq(portOf('http://127.0.0.1:7342'), 7342, 'portOf plain');
eq(portOf('http://127.0.0.1:7342/'), 7342, 'portOf trailing slash');
eq(portOf(''), 0, 'portOf empty');
eq(portOf('http://127.0.0.1'), 0, 'portOf no port');
eq(portOf('http://127.0.0.1:7342/path'), 0, 'portOf path (unsupported, must be 0 not garbage)');
eq(originOfPort(7343), 'http://127.0.0.1:7343', 'originOfPort');
eq(originOfPort(0), '', 'originOfPort 0');

// ── scope / profile ──
eq(scopeOf(PETS[0]), 'legacy', 'scopeOf explicit');
eq(scopeOf({ id: 'x' }), 'x', 'scopeOf falls back to id');
eq(scopeOf(null), '', 'scopeOf null');
eq(profileOf({ id: 'legacy' }), '', 'profileOf default fish = empty');
eq(profileOf({ id: 'current' }), 'current', 'profileOf non-default = id');
eq(profileOf({ id: 'current', profile: 'second' }), 'second', 'profileOf explicit wins');

// ── 认鱼 ──
eq(findFish(PETS, { id: 'current' })?.name, '鱼板妹妹7342', 'findFish by id');
eq(findFish(PETS, { scope: 'legacy' })?.id, 'legacy', 'findFish by scope');
eq(findFish(PETS, { port: 7342 })?.id, 'current', 'findFish by port');
eq(findFish(PETS, { origin: 'http://127.0.0.1:7341' })?.id, 'legacy', 'findFish by origin');
eq(findFish(PETS, { id: 'nope', port: 7341 })?.id, 'legacy', 'findFish falls through to port');
eq(findFish(PETS, {}), null, 'findFish no hints = null');
eq(findFish([], { port: 7341 }), null, 'findFish empty list');
eq(fishByPort(PETS, 7342)?.id, 'current', 'fishByPort');

// ── 主鱼 / 默认鱼 / 启用 ──
eq(primaryFish(PETS)?.id, 'current', 'primaryFish = qq one');
eq(primaryFish([{ id: 'a', origin: '', enabled: true }])?.id, 'a', 'primaryFish falls back to first enabled');
eq(defaultFish(PETS)?.id, 'legacy', 'defaultFish = profile "" one');
eq(enabledFish(PETS).length, 2, 'enabledFish all');
eq(enabledFish(PETS, false).length, 0, 'enabledFish master off');
eq(enabledFish([...PETS, { id: 'x', origin: '', enabled: false }]).length, 2, 'enabledFish skips disabled');

// ── 端口分配 / 新鱼 ──
eq(freePort(PETS), 7343, 'freePort skips used');
eq(freePort([], { start: 7350 }), 7350, 'freePort honours start');
ok(freePort(PETS, { start: 7341, max: 7342 }) === 0, 'freePort exhausts to 0');
eq(uniqueFishId(PETS), 'fish', 'uniqueFishId fresh');
eq(uniqueFishId([{ id: 'fish' }]), 'fish2', 'uniqueFishId bumps');

const fresh = makeFish({ pets: PETS, name: '小蓝' });
eq(fresh.id, 'fish', 'makeFish id');
eq(fresh.origin, 'http://127.0.0.1:7343', 'makeFish auto port');
eq(fresh.scope, 'fish', 'makeFish scope = id');
eq(fresh.profile, 'fish', 'makeFish profile = id');
eq(fresh.enabled, true, 'makeFish enabled');
eq(fresh.qq, false, 'makeFish qq default false');
eq(makeFish({ pets: PETS, name: 'X', port: 7355, qq: true }).origin, 'http://127.0.0.1:7355', 'makeFish explicit port');
ok((() => { try { makeFish({ pets: PETS, port: 7341 }); return false; } catch { return true; } })(), 'makeFish rejects used port');
ok((() => { try { makeFish({ pets: PETS, port: 0, start: 7341 }); return true; } catch { return false; } })(), 'makeFish picks a free port');

// ── QQ 号绑定（按鱼 ✓）──
eq(qqOf({ id: 'a' }, {}), { account: '', url: '', token: '', usable: false, bound: false, source: 'global' }, 'qqOf empty');
eq(qqOf({ id: 'a' }, { onebotUrl: 'ws://g:3001', onebotToken: 'T1', qqAccount: '111' }).source, 'global', 'qqOf falls back to global');
eq(qqOf({ id: 'a', onebotUrl: 'ws://x:3002', qqAccount: '222' }, { onebotUrl: 'ws://g:3001' }).source, 'fish', 'qqOf uses fish binding');
eq(qqOf({ id: 'a', onebotUrl: 'ws://x:3002' }, { onebotUrl: 'ws://g:3001' }).url, 'ws://x:3002', 'qqOf fish url wins');
eq(qqOf({ id: 'a' }, { onebotUrl: 'ws://g:3001' }).url, 'ws://g:3001', 'qqOf global url');
eq(qqOf({ id: 'a' }, {}).usable, false, 'qqOf not usable without url');
eq(maskSecret(''), '', 'maskSecret empty');
eq(maskSecret('short'), '****', 'maskSecret short');
eq(maskSecret('abcdefghijklmnop'), 'abcd****mnop', 'maskSecret long');
const withQq = makeFish({ pets: PETS, name: '小蓝', qqAccount: '333', onebotUrl: 'ws://x:3003' });
eq(withQq.qqAccount, '333', 'makeFish qqAccount');
eq(withQq.onebotUrl, 'ws://x:3003', 'makeFish onebotUrl');

// ── 摘要 ──
eq(summarize(PETS[1]), '鱼板妹妹7342(7342·QQ)', 'summarize qq');
eq(summarize({ id: 'z', name: '', origin: 'http://127.0.0.1:7399', enabled: false }), 'z(7399·停)', 'summarize stopped');
eq(summarize(null), '(none)', 'summarize null');

console.log(`fish.test: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL ' + f);
if (fails.length) process.exit(1);

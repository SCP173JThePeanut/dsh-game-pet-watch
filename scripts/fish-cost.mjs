// 养鱼成本核算：拿**真实测到的 token** 算钱，再折成"喂一条真鱼"的饲料钱。
// 价格全部用参数传进来，不猜。
//
//   node scripts/fish-cost.mjs [--in 2] [--cache 0.2] [--out 12]
//                             [--feed 1.8] [--fcr 1.5] [--fishJin 1]
//
// 默认价（元/百万 token）：输入(未命中) 2 / 输入(命中缓存) 0.2 / 输出 12
// 默认喂养口径（草鱼）：饲料 1.8 元/斤、饵料系数 1.5（长 1 斤肉吃 1.5 斤料）
//                       → 把一条鱼喂到 1 斤，饲料钱 ≈ 2.70 元
//
// 实测用量（插件 /state 的 runtime.usage.withImage，两次不同截图范围）：
//   A 全屏 1280×800：输入 1354（缓存命中 256）+ 输出 151
//   B 早先一次 1280×800：输入 971（缓存命中 640）+ 输出 144
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
const PRICE_IN = argOf('--in', 2);
const PRICE_CACHE = argOf('--cache', 0.2);
const PRICE_OUT = argOf('--out', 12);
const FEED_PER_JIN = argOf('--feed', 1.8); // 饲料 元/斤
const FCR = argOf('--fcr', 1.5); // 饵料系数：吃多少斤料长一斤肉
const FISH_JIN = argOf('--fishJin', 1); // 按"喂到几斤"折算

const FEED_PER_FISH = FEED_PER_JIN * FCR * FISH_JIN;

const SAMPLES = [
  { label: '全屏 1280×800', inputTokens: 1354, cacheReadTokens: 256, outputTokens: 151 },
  { label: '较早一次', inputTokens: 971, cacheReadTokens: 640, outputTokens: 144 },
];

const HOURS = 2;
const perHour = (intervalSec) => Math.round(3600 / intervalSec);
const cost = (s) => {
  const uncached = s.inputTokens - s.cacheReadTokens;
  return (uncached * PRICE_IN + s.cacheReadTokens * PRICE_CACHE + s.outputTokens * PRICE_OUT) / 1e6;
};
const money = (cny) => '¥' + cny.toFixed(4);
const feeds = (cny) => (cny / FEED_PER_FISH).toFixed(4);

console.log('=== 单次「看一眼 + 说一句」的真实用量与花费 ===');
for (const s of SAMPLES) {
  const uncached = s.inputTokens - s.cacheReadTokens;
  console.log(
    `  ${s.label}：输入 ${s.inputTokens}（未命中 ${uncached} + 缓存 ${s.cacheReadTokens}）+ 输出 ${s.outputTokens} → ${money(cost(s))}`,
  );
}
console.log('');
console.log(`价格口径：输入 ¥${PRICE_IN}/百万、缓存命中 ¥${PRICE_CACHE}/百万、输出 ¥${PRICE_OUT}/百万`);
console.log(`喂养口径：饲料 ¥${FEED_PER_JIN}/斤 × 饵料系数 ${FCR} × 喂到 ${FISH_JIN} 斤 = ${FEED_PER_FISH.toFixed(2)} 元/条`);
console.log('');

const modes = [
  { label: '正常节奏（每 20s）', intervalSec: 20 },
  { label: '退避 2×（每 40s）', intervalSec: 40 },
  { label: '退避 4×（每 80s）', intervalSec: 80 },
  { label: '退避 8×（每 160s，封顶附近）', intervalSec: 160 },
];
console.log(`=== 养两小时（${HOURS}h）按不同节奏 ===`);
for (const s of SAMPLES) {
  console.log(`  【${s.label}】`);
  for (const mode of modes) {
    const calls = perHour(mode.intervalSec) * HOURS;
    const total = cost(s) * calls;
    console.log(
      `    ${mode.label.padEnd(30)} ${String(calls).padStart(3)} 次  ${money(total).padEnd(9)} ＝ 能喂 ${feeds(total)} 条真鱼`,
    );
  }
}
console.log('');
console.log('=== 换个说法（用全屏那次的单价）===');
const base = cost(SAMPLES[0]);
const normal2h = base * perHour(20) * HOURS;
const backoff2h = base * perHour(160) * HOURS;
console.log(`  正常节奏养 2 小时 ≈ ${money(normal2h)} ＝ 一条真鱼饲料钱的 ${((normal2h / FEED_PER_FISH) * 100).toFixed(2)}%`);
console.log(`  8× 退避养 2 小时 ≈ ${money(backoff2h)} ＝ ${((backoff2h / FEED_PER_FISH) * 100).toFixed(2)}%`);
console.log(`  8× 退避连轴养一天（24h）≈ ${money(base * perHour(160) * 24)} ＝ 能喂 ${feeds(base * perHour(160) * 24)} 条真鱼`);
console.log(`  反过来：${FEED_PER_FISH.toFixed(2)} 元饲料钱，够这条电鱼以 8× 退避跑 ${Math.round(FEED_PER_FISH / (base * perHour(160)))} 小时`);
console.log('');
console.log('=== 高端多模态口径（输入 ¥10 / 缓存 ¥1 / 输出 ¥40）===');
const premium = (s) => {
  const uncached = s.inputTokens - s.cacheReadTokens;
  return (uncached * 10 + s.cacheReadTokens * 1 + s.outputTokens * 40) / 1e6;
};
for (const s of SAMPLES) {
  const n = premium(s) * perHour(20) * HOURS;
  const b = premium(s) * perHour(160) * HOURS;
  console.log(`  ${s.label}：正常 2h ${money(n)}（${feeds(n)} 条鱼）｜退避 2h ${money(b)}（${feeds(b)} 条鱼）`);
}

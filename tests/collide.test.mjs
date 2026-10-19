/**
 * 碰撞解算的"动量守恒"证明（纯函数，不用起宠物）。
 *
 * 背景：碰撞反应是插件当裁判、给两只鱼各设一次速度。之前那版"两边各给一个同向冲量"
 * 看着也守恒，但没用双方速度（静止挨上和高铁撞上反应一样、撞人的也不减速），
 * 手感就是"动量不守恒"。这里把规则钉死：
 *   · 等质量、沿法向：vA'+vB' === vA+vB（严格守恒）
 *   · 切线分量不变（斜撞不拐弯）
 *   · 都静止时走对称分离（±sep，和仍为 0）
 */
import { resolveCollision } from '../src/collide.js';

let pass = 0;
const fails = [];
const ok = (cond, label, extra = '') => {
  if (cond) {
    pass += 1;
  } else {
    fails.push(label + (extra ? ' → ' + extra : ''));
    console.log(`  ❌ ${label}${extra ? '  → ' + extra : ''}`);
  }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const sum = (r) => ({ x: r.a.x + r.b.x, y: r.a.y + r.b.y });
const inSum = (va, vb) => ({ x: va.x + vb.x, y: va.y + vb.y });

// ── 1. 正碰：A 以 100 撞静止的 B（n 从 B 指向 A，所以 A 朝 B 运动是 -n 方向） ──
{
  const r = resolveCollision({ va: { x: -100, y: 0 }, vb: { x: 0, y: 0 }, nx: 1, ny: 0, e: 0.9 });
  ok(near(r.a.x, -5, 1e-6), '撞人的那只几乎停下（-100 → -5）', String(r.a.x));
  ok(near(r.b.x, -95, 1e-6), '被撞的那只带走大部分速度（0 → -95）', String(r.b.x));
  ok(near(sum(r).x, -100, 1e-6), '动量守恒：vA′+vB′ = vA+vB');
  ok(r.kind === 'elastic', '走的是弹性分支');
}

// ── 2. 完全弹性（e=1）：法向速度交换 ──
{
  const r = resolveCollision({ va: { x: 60, y: 0 }, vb: { x: -20, y: 0 }, nx: 1, ny: 0, e: 1 });
  ok(near(r.a.x, -20, 1e-6) && near(r.b.x, 60, 1e-6), 'e=1 时两只鱼交换法向速度', `${r.a.x} / ${r.b.x}`);
}

// ── 3. 斜撞：切线分量必须原样保留 ──
{
  const r = resolveCollision({ va: { x: 0, y: 5 }, vb: { x: 0, y: 0 }, nx: 1, ny: 0, e: 0.9 });
  ok(near(r.a.y, 5) && near(r.b.y, 0), '切线分量不变（y 不受法向碰撞影响）', `${r.a.y} / ${r.b.y}`);
}

// ── 4. 都静止：对称分离，速度和仍为 0 ──
{
  const r = resolveCollision({ va: { x: 0, y: 0 }, vb: { x: 0, y: 0 }, nx: 1, ny: 0, sep: 30 });
  ok(r.kind === 'separate', '静止的一对走分离分支');
  ok(near(r.a.x, 30) && near(r.b.x, -30), '对称：A +30 / B -30', `${r.a.x} / ${r.b.x}`);
  ok(near(sum(r).x, 0), '分离分支也守恒（总和 0）');
}

// ── 5. 随机横扫：任意速度/方向下都必须守恒 ──
{
  let bad = 0;
  for (let i = 0; i < 500; i += 1) {
    const va = { x: (Math.random() - 0.5) * 400, y: (Math.random() - 0.5) * 400 };
    const vb = { x: (Math.random() - 0.5) * 400, y: (Math.random() - 0.5) * 400 };
    const ang = Math.random() * Math.PI * 2;
    const r = resolveCollision({ va, vb, nx: Math.cos(ang), ny: Math.sin(ang), e: Math.random() });
    const before = inSum(va, vb);
    const after = sum(r);
    if (!near(before.x, after.x, 1e-6) || !near(before.y, after.y, 1e-6)) bad += 1;
  }
  ok(bad === 0, '500 组随机速度/方向：每一组都严格守恒', bad ? `${bad} 组不守恒` : '');
}

// ── 6. 法向是 0 向量时不能炸（退化保护） ──
{
  const r = resolveCollision({ va: { x: 10, y: 0 }, vb: { x: 0, y: 0 }, nx: 0, ny: 0 });
  ok(Number.isFinite(r.a.x) && Number.isFinite(r.b.x), '法向为 0 时退化成 +x，不产生 NaN');
}

console.log(`collide.test: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL ' + f);
process.exit(fails.length ? 1 : 0);

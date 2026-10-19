/**
 * **两只鱼的碰撞解算**（纯函数，便于直接验"动量守恒"）。
 *
 * 每只鱼是一个独立进程，原版的碰撞 broker 只在自己进程里有效，所以由插件当裁判：
 * 拿到两只鱼的**真身盒 + 真实速度**，算出各自应该变成多少速度，再用 `/gpw/hit` 设回去。
 *
 * 规则（等质量、沿法向的一维碰撞 + 恢复系数 `e`）：
 *
 *   n = 从 B 指向 A 的单位向量（调用方给 nx/ny）
 *   vAn = vA·n，vBn = vB·n
 *   vAn' = ((1-e)·vAn + (1+e)·vBn) / 2
 *   vBn' = ((1-e)·vBn + (1+e)·vAn) / 2
 *
 * 于是 `vAn' + vBn' === vAn + vBn` —— **动量严格守恒**（等质量时就是速度和不变）。
 * `e = 1` 完全弹性（交换法向速度），`e = 0.9` 每次撞掉一点能量，不至于越撞越快。
 * **切线分量原样保留**，斜着撞不会突然拐弯。
 *
 * 特例：两只都几乎静止（|vAn| + |vBn| < movingThreshold）时，上面那套解出来的还是接近 0，
 * 它们会继续叠着。这时改成"对称分离"：A 沿 +n 拿 `sep`、B 沿 -n 拿 `sep`，
 * 两者速度**加起来仍然是 0**（动量照样守恒），但能把叠住的两只推开。
 *
 * @param {object} input
 * @param {{x:number,y:number}} input.va A 的速度（物理像素/秒，渲染端上报的那个）
 * @param {{x:number,y:number}} input.vb B 的速度
 * @param {number} input.nx 法向单位向量 x（B → A）
 * @param {number} input.ny 法向单位向量 y（B → A）
 * @param {number} [input.e] 恢复系数（0~1，默认 0.9）
 * @param {number} [input.sep] 静止时的分离速度（默认 20：够推开一点，又不至于把鱼甩飞）
 * @param {number} [input.movingThreshold] 判断"都基本静止"的阈值（默认 40）
 * @returns {{a:{x:number,y:number}, b:{x:number,y:number}, kind:'elastic'|'separate'}}
 */
export function resolveCollision({
  va = { x: 0, y: 0 },
  vb = { x: 0, y: 0 },
  nx = 1,
  ny = 0,
  e = 0.9,
  sep = 20,
  movingThreshold = 40,
} = {}) {
  const ax = Number(va.x) || 0;
  const ay = Number(va.y) || 0;
  const bx = Number(vb.x) || 0;
  const by = Number(vb.y) || 0;
  /** 法向必须归一化：传进来的长度不靠谱时（0）退化成 +x，绝不除以 0 */
  let ux = Number(nx) || 0;
  let uy = Number(ny) || 0;
  const len = Math.hypot(ux, uy);
  if (!(len > 1e-6)) {
    ux = 1;
    uy = 0;
  } else {
    ux /= len;
    uy /= len;
  }

  const vAn = ax * ux + ay * uy;
  const vBn = bx * ux + by * uy;

  /**
   * 切线分量（垂直于法向的那部分）**任何分支都要原样保留**，
   * 否则"斜着蹭过去"会被硬拽成沿法向弹开（手感很怪，也破坏守恒）。
   */
  const tAx = ax - vAn * ux;
  const tAy = ay - vAn * uy;
  const tBx = bx - vBn * ux;
  const tBy = by - vBn * uy;

  if (Math.abs(vAn) + Math.abs(vBn) < movingThreshold) {
    /**
     * 都基本静止 → 对称分离，但**法向要围绕原来的平均速度分开**：
     *   aN' = mean + sep，bN' = mean - sep  →  aN' + bN' = 2*mean = vAn + vBn
     * 这样既能把叠住的两只推开，又严格守恒（早先直接给 ±sep 会丢掉原来的法向速度）。
     */
    const meanN = (vAn + vBn) / 2;
    return {
      a: { x: tAx + (meanN + sep) * ux, y: tAy + (meanN + sep) * uy },
      b: { x: tBx + (meanN - sep) * ux, y: tBy + (meanN - sep) * uy },
      kind: 'separate',
    };
  }

  const vAn2 = ((1 - e) * vAn + (1 + e) * vBn) / 2;
  const vBn2 = ((1 - e) * vBn + (1 + e) * vAn) / 2;

  // v' = 切线 + v_n'·n
  return {
    a: { x: tAx + vAn2 * ux, y: tAy + vAn2 * uy },
    b: { x: tBx + vBn2 * ux, y: tBy + vBn2 * uy },
    kind: 'elastic',
  };
}

/**
 * 提示词守卫：人设/规则被"重置成默认"时自动恢复。
 *
 * 为什么需要（实测到的机制）：
 *   ① DSH 保存配置时，会把它"认识的那份配置"**整份**写进 `cordis.yml`；
 *      而插件没向 DSH 声明配置 schema → DSH 只认识基础字段，
 *      `personality`/`rules`/`compactSystem` 就从基准配置里消失了 → 插件回落成**代码默认值**。
 *   ② 紧接着我们自己的写回（面板保存提示词、切换游戏情况/机制库都会写 profile）
 *      把**当前这份默认值**又固化进 `cordis.patch.yml` → 自定义人设被"洗掉"且无法从文件恢复。
 *
 * 做法：把"最近一次见到的**非默认**提示词"记在数据目录里（`prompt-guard.json`），
 * 启动时若发现当前值等于默认值、而守卫里存着更丰富的自定义版本 → 自动写回并采用。
 *
 * 边界：
 *   - 只认"非默认"的值才进守卫（绝不把默认值当成"要保护的内容"，否则就是自欺欺人）
 *   - 只在"当前=默认 且 守卫里有非默认值"时恢复（用户主动清空/改写不会被打回）
 *   - 取"更长的那份"作为守卫：内容丰富的版本才值得保护
 */

/** 受保护的键（受 DSH 整份保存影响的就是这几个） */
export const PROMPT_KEYS = ['personality', 'rules', 'compactSystem'];

const norm = (v) => String(v ?? '').trim();

/**
 * 判断要不要恢复。
 * @param {{current:object, guard:object|null, defaults:object}} input
 * @returns {{restore:object, restored:string[], reason:'ok'|'reset-detected'}}
 */
export function resolvePromptGuard({ current = {}, guard = null, defaults = {} } = {}) {
  const restore = {};
  const restored = [];
  for (const key of PROMPT_KEYS) {
    const cur = norm(current[key]);
    const def = norm(defaults[key]);
    const saved = norm(guard?.[key]);
    if (!saved) continue;
    /**
     * 守卫里存的就是默认值 → 本来"没什么可恢复的"。
     *
     * ⚠️ 但**当前被清空**时必须补回来（2026-10-19 修：主人报"开口规则没了"）。
     * 起因：把默认提示词换成主人现用的那套之后，`saved === def` 恒成立 —— 于是
     * DSH 一旦把 rules 挤成空串，守卫就看戏，运行中的系统提示词里"规则："后面是空的 ✗。
     */
    if (saved === def) {
      if (cur === '') {
        restore[key] = saved;
        restored.push(key);
      }
      continue;
    }
    const curIsDefault = cur === def || cur === '';
    if (curIsDefault && saved.length > cur.length) {
      restore[key] = saved;
      restored.push(key);
    }
  }
  return { restore, restored, reason: restored.length ? 'reset-detected' : 'ok' };
}

/**
 * 从当前配置里挑出**值得存进守卫**的键（非默认）。
 *
 * 默认规则：只在非默认时更新，且**只在更长时覆盖** —— 避免一次"手滑清空"把守卫也洗成短版本 ✓。
 *
 * `options.force`：**明确保存**（面板/接口写入）时无条件覆盖 ✓。
 * 为什么需要（实测踩到 ✗）：主人主动换成**更短**的新人设时，"更长才覆盖"会让守卫
 * 拒绝更新 ✗ → 下次配置被 DSH 洗掉，它把**旧人设**恢复回来 ✗✗。
 * @returns {{next:object, changed:boolean}}
 */
export function updatePromptGuard(current = {}, guard = null, defaults = {}, options = {}) {
  const next = { ...(guard ?? {}) };
  let changed = false;
  for (const key of PROMPT_KEYS) {
    const cur = norm(current[key]);
    const def = norm(defaults[key]);
    if (!cur) continue;
    if (cur === def) continue; // 默认值不进守卫
    const saved = norm(next[key]);
    if (options.force || cur.length >= saved.length) {
      if (cur !== saved) {
        next[key] = cur;
        changed = true;
      }
    }
  }
  return { next, changed };
}

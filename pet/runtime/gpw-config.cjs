/**
 * 配置合并：副本自己的宠物配置 + **原版包内的动画池**。
 *
 * 为什么必须合并：原版 `assets/config.jsonc` 里那份 `animations`（106 段动画的分类与权重）
 * 才是宠物"会动"的全部依据；只写 pets 不写 animations，宠物就是一块静止的透明画布。
 * 手抄一份 25KB 的池子既不现实也会漂移，所以这里做三件事：
 *   1. 用**去除注释与尾逗号的 JSONC 解析**（不引第三方依赖）读原版默认配置
 *   2. 拿它的 animations / animationWeights / 文案 / 表情包映射当底座
 *   3. 用副本配置里的 pets 等字段覆盖（整段替换，与原版合并口径一致）
 */
'use strict';

const { readFileSync } = require('node:fs');

/** 去掉 JSONC 的注释与尾逗号（字符串内的 // 与 /* 不动） */
function stripJsonc(text) {
  let out = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 1;
      } else if (c === quote) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c === "'" ? '"' : c;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += c;
  }
  // 尾逗号：, 后面只跟空白与 } 或 ]
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return out;
}

function readJsonc(file) {
  const raw = readFileSync(file, 'utf8');
  return JSON.parse(stripJsonc(raw));
}

/**
 * 把副本配置合并成"完整成品"（原版 readAllConfig 的简化版：只做 main 条目）。
 *
 * ⚠️ 结构坑（踩过）：原版 `assets/config.jsonc` 是**单条目**文档——它的顶层就是 main 条目
 * （pets/animations/physics… 全在顶层），没有 `{ main: {...} }` 这层。而 /config 的应答形状是
 * `{ main: {...}, <种类>: {...} }`。所以不能把两份文档平铺合并（原版的 pets 会赢过副本的 pets）。
 *
 * @param {{configFile:string, upstreamConfigFile:string}} options
 */
function readMergedConfig(options) {
  const baseDoc = readJsonc(options.upstreamConfigFile);
  const userDoc = readJsonc(options.configFile);
  // 兼容两种写法：单条目文档（顶层即条目）或成品文档（{main:{...}}）
  const baseMain = baseDoc.main && typeof baseDoc.main === 'object' ? baseDoc.main : baseDoc;
  const userMain = userDoc.main && typeof userDoc.main === 'object' ? userDoc.main : userDoc;

  const merged = Object.assign({}, baseMain, userMain);
  // 整段替换口径（与原版一致）：写了**且非空**才用自己的那一整段。
  // 空对象 / 空数组视为"没写"——副本的默认配置里就有 animations: {}，它会把动画池清空成一块静止画布。
  const section = (userValue, baseValue) =>
    userValue && typeof userValue === 'object' && Object.keys(userValue).length > 0 ? userValue : baseValue;
  merged.animations = section(userMain.animations, baseMain.animations);
  merged.animationWeights = section(userMain.animationWeights, baseMain.animationWeights);
  merged.physics = Object.assign({}, baseMain.physics, userMain.physics);
  if (!Array.isArray(merged.pets) || merged.pets.length === 0) {
    throw new Error('副本配置里 pets 为空：' + options.configFile);
  }
  // 副本一个窗口只承载一只
  const only = Object.assign({}, merged.pets[0]);
  /**
   * 面板偏好里的"桌宠大小"覆盖配置里的 size。
   *
   * 渲染端用它决定动画显示大小（sprite.js: `this.size = pet.size` → 写 --pet-size →
   * .pet-stage / video 的宽高），所以这是"让滑杆真正改变动画大小"的唯一入口。
   * 范围在 prefs 那侧已夹取（200–900），这里只做合法性兜底。
   */
  const prefSize = Number(options.petSize);
  if (Number.isFinite(prefSize) && prefSize > 0) only.size = Math.round(prefSize);
  merged.pets = [only];
  return { main: merged };
}

module.exports = { readMergedConfig, readJsonc, stripJsonc };

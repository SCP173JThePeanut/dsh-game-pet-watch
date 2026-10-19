/**
 * 历史快照导出：把"活页面 + 数据"合成一个**自包含**的 HTML 文件。
 *
 * 用户要的是"整个 html 保存下来给朋友看看"，所以导出件必须满足：
 *   ① 打开就能看（**不依赖插件、不依赖网络**）：数据直接嵌在文件里
 *   ② 配图也在里面（表情包是这页最有趣的部分）：转成 data URI 内联
 *   ③ 一个 UI 两份用途：仍然用 `web/history.html` 那份页面，只是注入数据 + 让它走"快照模式"
 *      （否则就会出现两套界面，改一处忘一处）
 *
 * 安全点：JSON 直接塞进 `<script>` 会被内容里的 `</script>` 提前结束标签，
 * 所以必须把 `<` 转义成 `\u003c`（JSON 里合法、浏览器解析回来还是 `<`）。
 */

/** 把任意字符串安全地放进 <script> 里（转义 < 、U+2028/U+2029 这类行分隔符） */
export function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 生成快照 HTML。
 * @param {string} template 活页面的 HTML（`web/history.html`）
 * @param {object} payload 要嵌进去的数据（entries / selfName / sources / exportedAt ...）
 * @returns {string}
 */
export function buildSnapshotHtml(template, payload) {
  const injection = `<script>window.__HISTORY__ = ${safeJsonForScript(payload)};</script>`;
  // 插在页面自己的脚本之前：这样页面脚本一跑就能读到数据
  const at = template.indexOf('<script>');
  if (at === -1) return template.replace('</body>', injection + '\n</body>');
  return template.slice(0, at) + injection + '\n    ' + template.slice(at);
}

/** 依据字节数与 mime 生成 data URI（导出件里图片就是这样内联的） */
export function toDataUri(buffer, mime) {
  return `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`;
}

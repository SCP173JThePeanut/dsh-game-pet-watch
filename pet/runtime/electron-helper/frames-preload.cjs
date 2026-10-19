/**
 * 抽帧台的 preload：给离屏页一条**主动回传**结果的通道。
 *
 * 为什么不用主进程 `executeJavaScript` 读 `window.__frames`：
 * 在 `contextIsolation: true` 下它跑在**隔离世界**，看不到页面主世界的变量——
 * 我为此踩过一次：读到的永远是初始值，错误信息因此假得离谱（状态写着 step=play:start、
 * 而视频其实已经在播）。正确姿势是页面自己把结果发回来。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frameHost', {
  done(state) {
    ipcRenderer.send('gpw:frames-done', state);
  },
  fail(message, step) {
    ipcRenderer.send('gpw:frames-done', { ok: false, error: String(message), step: step || 'unknown' });
  },
});

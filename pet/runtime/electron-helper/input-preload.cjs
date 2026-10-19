/**
 * 悬浮输入框小窗的 preload：只暴露"鼠标在本窗内/外"一个通道。
 *
 * 可见性由主进程决定（条件 = 光标在宠物上 或 在本窗上），渲染端只上报自己这一半。
 * 刻意不暴露任何窗口控制能力（移动/缩放/穿透）—— 历史教训：多一个控制器翻转穿透就会打架。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gpwInput', {
  setHover(on) {
    ipcRenderer.send('gpw:input-hover', !!on);
  },
});

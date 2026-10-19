/**
 * dsh-pet-gpw 的 preload：只暴露副本浮层需要的最小原语。
 *
 * 与主人进程的两条通道：
 *   setHitRect  浮层把"宠物身体 + 可见输入框"的窗口内矩形报上去 → 主进程据此决定可否交互
 *   setInputBusy  正在打字/发送：主进程在此期间绝不把窗口翻回点击穿透
 *   openPanel   打开观察面板窗
 *   openExternal  用系统浏览器开链接
 *
 * 刻意不暴露原版那套 setBounds/setInteractive：副本的宠物固定在画布右下角，不漫游、不抛掷。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gpwHost', {
  setHitRect(rect) {
    ipcRenderer.send('gpw:hit-rect', rect || null);
  },
  setInputBusy(busy) {
    ipcRenderer.send('gpw:input-busy', !!busy);
  },
  openPanel() {
    ipcRenderer.send('gpw:open-panel');
  },
  openExternal(url) {
    ipcRenderer.send('gpw:open-external', url);
  },
  /** 排障用：把主进程侧的窗口状态问回来（自检脚本读它判断"窗口到底可见吗"） */
  probeWindow() {
    return ipcRenderer.invoke('gpw:probe-window');
  },
  version: '0.1.0',
});

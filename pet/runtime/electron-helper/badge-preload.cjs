/**
 * 「观察中」小窗的 preload：只暴露一个"展开/收起"通道。
 *
 * 为什么需要它：收起时窗口要缩到**只有胶囊那么大**（这样它虽然永远可交互，却几乎不遮挡桌面），
 * 展开时才放大并显示输入框。窗口尺寸只有主进程能改，所以渲染端只能请求。
 *
 * 刻意**不暴露**任何点击穿透相关的方法（历史教训：两处同时翻转穿透会互相打架，
 * 见 gpw-main.cjs 的 applyPinTo 注释）。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gpwBadge', {
  /** 把胶囊实际需要的宽度报给主进程（名字长度不定，窗口要按内容自适应） */
  reportWidth(width) {
    ipcRenderer.send('gpw:badge-width', Number(width));
  },
  /** 打开观察面板（面板窗由主进程创建；这是面板的唯一入口） */
  openPanel() {
    ipcRenderer.send('gpw:open-panel');
  },
  /**
   * 订阅"光标在宠物身上"（由主进程从宠物窗的渲染端转发过来）。
   * 这是"悬停宠物 → 浮出输入框"那条需求的通道：输入框在小窗里，
   * 而悬停发生在宠物上，小窗自己收不到那个 mouseenter。
   */
  onPetHover(cb) {
    ipcRenderer.on('gpw:pet-hover', (_event, on) => cb(on === true));
  },
});

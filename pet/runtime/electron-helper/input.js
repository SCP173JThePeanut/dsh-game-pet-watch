/**
 * 悬浮输入框小窗的脚本。
 *
 *   ① 发送消息给插件（/ask），带发送锁（防重，这是"一次操作打好几次 API"的真正来源）；
 *   ② 上报"鼠标在本窗内/外"给主进程 —— 主进程据此决定这个窗该显示还是隐藏。
 *
 * 为什么可见性由主进程统一管：显示条件是"光标在宠物上 **或** 在本窗上"，
 * 而"光标在宠物上"只有主进程知道（从宠物窗渲染端转发过来）。渲染端不能改窗口可见性，
 * 所以这里只上报自己的进出，判断留给主进程（见 gpw-main.cjs 的 updateInputVisibility）。
 */
const q = new URLSearchParams(location.search);
const PORT = q.get('port') || '7341';
/**
 * 插件地址不能只在建窗时取一次（DSH 重启换端口后，输入框会一直发给死端口）。
 * 页面是 file:// 源，所以用绝对地址问宠物自己的服务要"当前插件地址"。
 */
let PLUGIN = (q.get('plugin') || 'http://127.0.0.1:19387').replace(/\/$/, '');
let API = PLUGIN + '/game-pet-watch';
const PET_API = 'http://127.0.0.1:' + PORT;
async function refreshPluginOrigin() {
  try {
    const res = await fetch(PET_API + '/gpw/brand', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (!res.ok) return;
    const data = await res.json();
    const next = typeof data?.pluginOrigin === 'string' ? data.pluginOrigin.replace(/\/$/, '') : '';
    if (next && next !== PLUGIN) { PLUGIN = next; API = PLUGIN + '/game-pet-watch'; }
  } catch { /* 宠物服务不可用就保持原样 */ }
}
void refreshPluginOrigin();
setInterval(() => void refreshPluginOrigin(), 10000);

const field = document.querySelector('#bar input');
const sendBtn = document.querySelector('#bar .send');
const scopeBtn = document.querySelector('#bar #scope');
/**
 * **本鱼 / 全体**：默认本鱼（站在谁面前就是跟谁说话）。
 * 选择记在 localStorage，下次打开还是这个。
 */
let audience = localStorage.getItem('gpw-audience') === 'all' ? 'all' : 'self';
function paintScope() {
  if (!scopeBtn) return;
  scopeBtn.textContent = audience === 'all' ? '全体' : '本鱼';
  scopeBtn.title =
    audience === 'all'
      ? '现在：全体（所有鱼都能看到）— 点一下改为只对本鱼'
      : '现在：本鱼（只记这条鱼，不广播）— 点一下改为全体';
  scopeBtn.classList.toggle('all', audience === 'all');
}
paintScope();
scopeBtn?.addEventListener('click', () => {
  audience = audience === 'all' ? 'self' : 'all';
  localStorage.setItem('gpw-audience', audience);
  paintScope();
  field.focus();
});

function tellHover(on) {
  if (window.gpwInput && typeof window.gpwInput.setHover === 'function') window.gpwInput.setHover(on);
}
document.body.addEventListener('mouseenter', () => tellHover(true));
document.body.addEventListener('mouseleave', () => tellHover(false));
// 焦点进来也算"在用"，避免鼠标停在窗口边缘时被隐藏
field.addEventListener('focus', () => tellHover(true));

let sending = false;
async function send() {
  if (sending) return;
  const text = field.value.trim();
  if (!text) return;
  sending = true;
  sendBtn.disabled = true;
  sendBtn.textContent = '等待…';
  field.value = '';
  try {
    const res = await fetch(API + '/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      /**
       * `port` 让插件认出**是哪条鱼**（不带会落到空 scope：表情包清单与按鱼记忆全丢）；
       * `audience` 由上面的「本鱼 / 全体」按钮决定。
       */
      body: JSON.stringify({ text, push: 'gpw', pet: 'gpw', port: Number(PORT), audience }),
    });
    const data = await res.json();
    // 回复走宠物气泡显示（插件投 /gpw/say），这里只需把失败原因让用户看到
    if (!data?.ok) {
      field.placeholder = '失败：' + String(data?.message || '未知错误').slice(0, 40);
      setTimeout(() => {
        field.placeholder = '跟鱼说一句，Enter 发送';
      }, 4000);
    }
  } catch (error) {
    field.placeholder = '发送失败：' + String(error.message || error).slice(0, 40);
    setTimeout(() => {
      field.placeholder = '跟鱼说一句，Enter 发送';
    }, 4000);
  } finally {
    sending = false;
    sendBtn.disabled = false;
    sendBtn.textContent = '发送';
  }
}

sendBtn.addEventListener('click', () => void send());
field.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
  if (event.key === 'Escape') tellHover(false);
});

// 窗口每次被显示时自动聚焦，省一次点击
window.addEventListener('focus', () => field.focus());
setTimeout(() => field.focus(), 200);

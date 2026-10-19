/**
 * 检查宠物右键菜单：滚动会不会被"刷新"回顶部 + 内容超出有没有可用滚动条。
 *
 * 关键：原版的右键是走 pointerdown(button===2) 分支（不是 contextmenu 事件），
 * 所以这里派发真实的 pointerdown 序列。
 *   node scripts/menu-check.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSPECT = join(HERE, 'gpw-inspect.mjs');

function evalInPage(expr) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INSPECT, '--raw', expr], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.on('close', () => resolve(out.trim()));
    child.on('error', () => resolve(''));
  });
}

const OPEN = `(() => {
  const stage = document.querySelector('.pet-stage');
  if (!stage) return 'no-stage';
  const r = stage.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  stage.dispatchEvent(new PointerEvent('pointerdown', opts));
  window.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
  window.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
  return JSON.stringify({ sent: true, x, y });
})()`;

const PROBE = `(() => {
  const menu = document.querySelector('.dsh-pet-menu');
  if (!menu) return JSON.stringify({ menu: false, seenDebug: !!window.__dshPetDebug, menuFlag: window.__dshPetDebug && window.__dshPetDebug.menuOpen });
  const c0 = menu.querySelector('.dsh-pet-menu-column');
  const cols = [...menu.querySelectorAll('.dsh-pet-menu-column')].map((c) => ({
    clientH: c.clientHeight, scrollH: c.scrollHeight, canScroll: c.scrollHeight > c.clientHeight + 2,
    overflowY: getComputedStyle(c).overflowY,
  }));
  let afterSet = null;
  if (c0) { c0.scrollTop = 40; afterSet = c0.scrollTop; window.__menuNodeMark = c0; }
  return JSON.stringify({
    menu: true, items: menu.querySelectorAll('.dsh-pet-menu-item').length,
    columns: cols, scrollSetTo: 40, scrollAfterSet: afterSet,
  });
})()`;

const AFTER = `(() => {
  const menu = document.querySelector('.dsh-pet-menu');
  if (!menu) return JSON.stringify({ menu: false, note: '菜单已消失（可能被判定为点击外部而关闭）' });
  const c0 = menu.querySelector('.dsh-pet-menu-column');
  return JSON.stringify({
    menu: true,
    stillSameNode: c0 === window.__menuNodeMark,
    scrollNow: c0 ? c0.scrollTop : null,
    menuFlag: window.__dshPetDebug && window.__dshPetDebug.menuOpen,
  });
})()`;

console.log('① 派发真右键序列…');
console.log('   ' + (await evalInPage(OPEN)));
await new Promise((r) => setTimeout(r, 700));

console.log('② 菜单首帧 + 第一列滚到 40：');
console.log('   ' + (await evalInPage(PROBE)));
await new Promise((r) => setTimeout(r, 6000));

console.log('③ 6 秒后再看（scrollNow 变 0 / 节点被换 = 就是"刷新"）：');
console.log('   ' + (await evalInPage(AFTER)));

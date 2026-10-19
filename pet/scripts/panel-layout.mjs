/**
 * 面板窗排障：量"哪个元素在裁内容"，确认滚动容器与滚动条是否可用。
 *
 * 背景：用户报"菜单内容超出框目前也还没有滑块"。要判断到底是
 *   ① 外层滚动容器高度算错（内容根本滚不到）
 *   ② 滚动条被样式藏了/太细看不见
 *   ③ 内层某个固定高度容器把内容裁掉了
 * 就得把每一层的 clientHeight / scrollHeight / overflow 都打出来。
 *
 *   node scripts/panel-layout.mjs [--window 游戏观察]
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSPECT = join(HERE, 'gpw-inspect.mjs');

const argv = process.argv.slice(2);
const idx = argv.indexOf('--window');
const TITLE = idx !== -1 && argv[idx + 1] ? argv[idx + 1] : '游戏观察';

function ev(expr) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INSPECT, '--raw', expr, '--window', TITLE], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.on('close', () => resolve(out.trim()));
    child.on('error', () => resolve(''));
  });
}

const EXPR = `(() => {
  const rows = [];
  const add = (label, node) => {
    if (!node) { rows.push({ label, missing: true }); return; }
    const cs = getComputedStyle(node);
    rows.push({
      label,
      h: node.clientHeight, scrollH: node.scrollHeight,
      canScroll: node.scrollHeight > node.clientHeight + 2,
      overflowY: cs.overflowY,
      flex: cs.flex,
      height: cs.height,
      scrollTop: node.scrollTop,
      barW: node.offsetWidth - node.clientWidth, // >0 表示滚动条占了宽度（即真的存在）
    });
  };
  add('html', document.documentElement);
  add('body', document.body);
  add('.wrap', document.querySelector('.wrap'));
  add('#body', document.getElementById('body'));
  add('#page', document.getElementById('page'));
  const tabs = document.querySelector('.tabs');
  const head = document.querySelector('.head');
  const foot = document.querySelector('.foot');
  rows.push({ label: 'head.h', h: head ? head.offsetHeight : null });
  rows.push({ label: 'tabs.h', h: tabs ? tabs.offsetHeight : null });
  rows.push({ label: 'foot.h', h: foot ? foot.offsetHeight : null });
  rows.push({ label: 'window', h: innerHeight, w: innerWidth });
  // 试着滚到底，看能不能真滚
  const page = document.getElementById('page');
  if (page) { page.scrollTop = 99999; rows.push({ label: 'scrollToBottom ->', scrollTop: page.scrollTop, max: page.scrollHeight - page.clientHeight }); }
  return JSON.stringify(rows);
})()`;

const raw = await ev(EXPR);
try {
  const rows = JSON.parse(JSON.parse(raw));
  for (const r of rows) {
    if (r.missing) {
      console.log(`${r.label}: 不存在`);
      continue;
    }
    if (r.h !== undefined && r.scrollH === undefined) {
      console.log(`${r.label}: ${r.h}`);
      continue;
    }
    if (r.scrollTop !== undefined && r.h === undefined) {
      console.log(`${r.label} scrollTop=${r.scrollTop} max=${r.max}`);
      continue;
    }
    console.log(
      `${r.label.padEnd(9)} clientH=${String(r.h).padStart(4)} scrollH=${String(r.scrollH).padStart(4)} ` +
        `可滚=${r.canScroll ? '是' : '否'} overflowY=${String(r.overflowY).padEnd(7)} 滚动条宽=${r.barW} h=${r.height}`,
    );
  }
} catch {
  console.log('原始输出:', raw.slice(0, 500));
}

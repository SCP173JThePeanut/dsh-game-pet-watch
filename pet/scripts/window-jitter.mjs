/**
 * 观察宠物窗是否在"抖"（尺寸/位置反复变化）。
 *
 * 为什么要单独测这个：面板菜单滚动条一滑就弹回顶部、面板内容超出框却没有滑块，
 * 这两个症状都指向同一个原因——**窗口被反复 resize**（每次 resize 都会重排、滚动归零）。
 * 副本与上游 renderer/sprite 逐行一致，所以抖动只可能来自主进程侧。
 *
 *   node scripts/window-jitter.mjs [--samples 20] [--every 500]
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSPECT = join(HERE, 'gpw-inspect.mjs');

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : d;
};
const SAMPLES = argOf('--samples', 20);
const EVERY = argOf('--every', 500);

function probe() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INSPECT, '--raw', '(async()=>{const p=await window.gpwHost.probe();return JSON.stringify({w:p.windows.map(w=>({t:w.title.slice(0,10),b:w.bounds,ign:w.ignoring})), inner:{w:innerWidth,h:innerHeight}, dpr:devicePixelRatio})})()'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.on('close', () => {
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) return resolve(null);
      try {
        resolve(JSON.parse(JSON.parse(m[0])));
      } catch {
        resolve(null);
      }
    });
    child.on('error', () => resolve(null));
  });
}

console.log(`采样 ${SAMPLES} 次，每次间隔 ${EVERY}ms`);
const seen = [];
for (let i = 0; i < SAMPLES; i += 1) {
  const s = await probe();
  if (s) {
    const pet = s.w.find((w) => w.t.includes('桌宠')) ?? s.w[0];
    const key = pet ? `${pet.b.x},${pet.b.y} ${pet.b.width}x${pet.b.height}` : '?';
    seen.push(key);
    console.log(`#${String(i + 1).padStart(2)}  ${key}  viewport=${s.inner.w}x${s.inner.h} dpr=${s.dpr}  ignoring=${pet?.ign ?? '?'}`);
  } else {
    console.log(`#${String(i + 1).padStart(2)}  探测失败`);
  }
  if (i < SAMPLES - 1) await new Promise((r) => setTimeout(r, EVERY));
}

const uniq = [...new Set(seen)];
console.log('');
console.log(`不同窗口几何状态：${uniq.length} 种`);
for (const u of uniq) console.log('  ' + u);
console.log('');
if (uniq.length <= 1) console.log('结论：窗口稳定，没有抖动 → 滚动问题不是 resize 引起的，去查菜单自身的重绘。');
else console.log('结论：窗口在抖动（上面列出的几何在来回切）→ 这就是滚动条弹回顶部/内容无滑块的根因。');

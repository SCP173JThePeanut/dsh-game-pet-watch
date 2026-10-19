// 光标扫描：把光标放到若干真实屏幕坐标，读回渲染端的判定与输入框状态，
// 用来反推"页面判定"落在真实屏幕的哪里（比读坐标推公式可靠）。
//
//   node scripts/hover-sweep.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSPECT = join(HERE, 'gpw-inspect.mjs');

function setCursor(x, y) {
  const ps = [
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class SweepCursor {',
    '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    '}',
    '"@ -ErrorAction SilentlyContinue',
    '[SweepCursor]::SetProcessDPIAware() | Out-Null',
    `[SweepCursor]::SetCursorPos(${x}, ${y}) | Out-Null`,
  ].join('\n');
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('close', resolve);
    child.on('error', resolve);
  });
}

function probe() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INSPECT, '--raw', 'JSON.stringify({over:window.__gpwOverPet, local:window.__gpwLastCursor, rect:(()=>{const r=window.__gpwTargetRect;return r?{x:Math.round(r.x),y:Math.round(r.y),r:Math.round(r.right),b:Math.round(r.bottom)}:null})()})'], {
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

const points = [];
for (let y = 100; y <= 1500; y += 200) {
  for (let x = 200; x <= 2400; x += 300) points.push([x, y]);
}

console.log('=== 光标扫描（真实屏幕物理坐标）===');
let hits = 0;
for (const [x, y] of points) {
  await setCursor(x, y);
  await new Promise((r) => setTimeout(r, 260));
  const s = await probe();
  const over = s?.over === true;
  if (over) hits += 1;
  if (over || (x % 600 === 200 && y % 400 === 100)) {
    console.log(`${over ? '✅' : '  '} 光标 ${String(x).padStart(4)},${String(y).padStart(4)}  over=${over}  页面局部坐标=${s?.local ? s.local.x.toFixed(0) + ',' + s.local.y.toFixed(0) : '?'}`);
  }
}
console.log('');
console.log(`命中 ${hits} / ${points.length} 个采样点`);
if (hits === 0) {
  console.log('结论：整个屏幕都没有命中 → 页面判定区域完全落在屏幕外（坐标换算不一致）');
} else {
  console.log('结论：命中区域存在，上面带 ✅ 的点就是宠物实际可交互的位置');
}

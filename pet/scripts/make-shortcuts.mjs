// 在桌面创建两个快捷方式：启动桌宠 / 停止桌宠。
//   node scripts/make-shortcuts.mjs
// 用途：自动拉起（插件保活）之外的**手动通道** —— 宠物不在时双击启动，想收起来双击停止。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const START = join(PACKAGE_ROOT, 'scripts', 'gpw-start.mjs');
const node = process.execPath;
const desktop = join(homedir(), 'Desktop');

const shortcuts = [
  { name: '启动桌宠.lnk', args: `"${START}"`, desc: '启动 dsh-pet-gpw 桌宠副本' },
  { name: '停止桌宠.lnk', args: `"${START}" --stop`, desc: '停掉 dsh-pet-gpw 桌宠副本' },
];

if (!existsSync(START)) {
  console.error('找不到启动脚本：' + START);
  process.exit(1);
}
if (!existsSync(desktop)) {
  console.error('找不到桌面目录：' + desktop);
  process.exit(1);
}

for (const item of shortcuts) {
  const target = join(desktop, item.name);
  const ps = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$sc = $ws.CreateShortcut('${target}')`,
    `$sc.TargetPath = '${node}'`,
    `$sc.Arguments = '${item.args}'`,
    `$sc.WorkingDirectory = '${PACKAGE_ROOT}'`,
    `$sc.Description = '${item.desc}'`,
    `$sc.WindowStyle = 7`,
    '$sc.Save()',
  ].join('\n');
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    stdio: 'ignore',
  });
  console.log((r.status === 0 ? '✅ ' : '❌ ') + target);
}
console.log('');
console.log('双击「启动桌宠」＝ 把宠物拉起来；双击「停止桌宠」＝ 收起来。');
console.log('（DSH 开着时它本来就会自动拉起，这两个只是手动通道。）');

/**
 * 画面捕捉：调 scripts/capture.ps1，把目标窗口客户区（或主屏）截成 PNG。
 *
 * 纯 Node 拿不到「窗口客户区」的屏幕像素（Windows 上要么走 Win32/GDI，要么走整屏抓取），
 * 所以这里固定用系统 PowerShell：脚本零依赖、纯 ASCII（PS 5.1 按 ANSI 码页读 .ps1，
 * 文件里一旦有非 ASCII 字节，解析器会在第一条语句之前就炸）。
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** src/ 的上一级才是包根 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(PACKAGE_ROOT, 'scripts', 'capture.ps1');
const POWERSHELL_CANDIDATES = ['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell'];

/**
 * 解析一个可用的 PowerShell（模块级，供截图之外的模块复用 —— 例如图片压缩）。
 *
 * 为什么要抽出来：图片压缩第一版自己写了一套候选循环，结果真机上
 * 报 `spawn pwsh ENOENT`（压缩静默失效、退回原图 ✗），而截图那套一直是好的 ✓。
 * 同一件事不要再写第二遍。
 *
 * 候选顺序：pwsh.exe → pwsh → powershell.exe → powershell → **System32 下的绝对路径**。
 * 最后那个是保底：某些宿主进程的 PATH 被裁剪过，只有绝对路径能找到。
 */
export async function resolvePowerShell(log) {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\Windows';
  const candidates = [
    ...POWERSHELL_CANDIDATES,
    `${systemRoot}\System32\WindowsPowerShell\v1.0\powershell.exe`,
  ];
  for (const candidate of candidates) {
    const code = await new Promise((done) => {
      let handle;
      try {
        handle = spawn(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        done(-1);
        return;
      }
      handle.on('error', () => done(-1));
      handle.on('close', (c) => done(c ?? -1));
    });
    if (code === 0) {
      log?.('PowerShell = ' + candidate);
      return candidate;
    }
    log?.(`PowerShell 候选不可用：${candidate}`);
  }
  return '';
}

export class CaptureEngine {
  /**
   * @param {{dshHome:string, log?:(m:string)=>void}} options
   */
  constructor({ dshHome, log }) {
    this.shotsDir = join(dshHome, 'game-pet-watch', 'shots');
    this.log = log ?? (() => {});
    this.powerShell = undefined;
    this.seq = 0;
    this.shots = [];
    this.count = 0;
    this.lastInfo = '';
  }

  async resolvePowerShell() {
    if (this.powerShell !== undefined) return this.powerShell;
    for (const candidate of POWERSHELL_CANDIDATES) {
      const code = await new Promise((done) => {
        let handle;
        try {
          handle = spawn(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch {
          done(-1);
          return;
        }
        handle.on('error', () => done(-1));
        handle.on('close', (c) => done(c ?? -1));
      });
      if (code === 0) {
        this.powerShell = candidate;
        this.log('PowerShell = ' + candidate);
        return candidate;
      }
    }
    this.powerShell = null;
    return null;
  }

  /**
   * 截一帧。
   * @param {{windowTitle:string, maxWidth:number, keepShots:number, captureTimeoutMs:number}} config
   * @returns {Promise<{file:string, info:string, at:number, ms:number}>}
   */
  async capture(config) {
    const shell = await this.resolvePowerShell();
    if (!shell) throw new Error('找不到 PowerShell（pwsh.exe / powershell.exe 都不可用），无法捕捉画面');
    await mkdir(this.shotsDir, { recursive: true });

    const ring = Math.max(1, config.keepShots || 1);
    this.seq = this.seq % ring;
    const file = join(this.shotsDir, `shot-${this.seq}.png`);
    this.seq = (this.seq + 1) % ring;

    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT,
      '-Title',
      config.windowTitle,
      '-Out',
      file,
      '-MaxWidth',
      String(config.maxWidth),
    ];
    const started = Date.now();
    const result = await new Promise((done) => {
      let handle;
      try {
        handle = spawn(shell, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        done({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
        return;
      }
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try {
          handle.kill();
        } catch {
          /* 已退出 */
        }
        done({ code: -2, stdout, stderr: '捕捉超时（' + config.captureTimeoutMs + 'ms）' });
      }, config.captureTimeoutMs);
      handle.stdout?.setEncoding('utf8');
      handle.stderr?.setEncoding('utf8');
      handle.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      handle.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
      handle.on('error', (error) => {
        clearTimeout(timer);
        done({ code: -1, stdout, stderr: error instanceof Error ? error.message : String(error) });
      });
      handle.on('close', (code) => {
        clearTimeout(timer);
        done({ code: code ?? -1, stdout, stderr });
      });
    });

    if (result.code !== 0) throw new Error('截图失败：' + (result.stderr.trim() || '退出码 ' + result.code));
    if (!existsSync(file)) throw new Error('截图脚本没有产出文件：' + file);

    const at = Date.now();
    const info = result.stdout.trim();
    this.lastInfo = info;
    this.count += 1;
    // 字节数当"画面有没有变"的廉价指纹：同尺寸同编码下，内容一变压缩长度几乎必然变
    let bytes = 0;
    try {
      bytes = require('node:fs').statSync(file).size;
    } catch {
      /* 拿不到就当 0，活跃度判定会保守地认为"变了" */
    }
    this.lastBytes = bytes;
    this.shots.push({ id: `shot-${this.seq}`, file, at, info, bytes });
    while (this.shots.length > Math.max(1, config.keepShots)) {
      const dropped = this.shots.shift();
      if (dropped && dropped.file !== file) void rm(dropped.file, { force: true }).catch(() => {});
    }
    return { file, info, at, ms: at - started, bytes };
  }

  /**
   * 键鼠空闲毫秒（Win32 GetLastInputInfo）。
   * 为什么用"单次 pwsh"而不是常驻进程：调用频率低（退避后 10 秒一次），
   * 而常驻进程要维护、要管生命周期，这里不值得。
   * 拿不到就返回 null（调用方据此"当它一直在忙"，绝不因为探针坏了就降频）。
   */
  async idleMs() {
    const shell = await this.resolvePowerShell();
    if (!shell) return null;
    // 用一段**无引号**的 -Command：把 C# 源码整体用双引号包住会被 PowerShell 与 shell 两层转义搞崩，
    // 这里改用 -EncodedCommand（Base64 + UTF-16LE），两侧都不可能转义出错。
    const source = [
      'Add-Type -TypeDefinition @"',
      'using System;using System.Runtime.InteropServices;',
      'public static class GPWIdle{',
      '  [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }',
      '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII p);',
      '  public static uint Ms(){ LII l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l);',
      '    if(!GetLastInputInfo(ref l)) return 0; return (uint)Environment.TickCount - l.dwTime; }',
      '}',
      '"@ -ErrorAction SilentlyContinue',
      '[GPWIdle]::Ms()',
    ].join('\n');
    const encoded = Buffer.from(source, 'utf16le').toString('base64');
    const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
    const value = await new Promise((done) => {
      let handle;
      try {
        handle = spawn(shell, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      } catch {
        done(undefined);
        return;
      }
      let out = '';
      const timer = setTimeout(() => {
        try {
          handle.kill();
        } catch {
          /* 已退出 */
        }
        done(undefined);
      }, 6000);
      handle.stdout?.setEncoding('utf8');
      handle.stdout?.on('data', (c) => {
        out += c;
      });
      handle.on('error', () => {
        clearTimeout(timer);
        done(undefined);
      });
      handle.on('close', () => {
        clearTimeout(timer);
        const n = Number(out.trim());
        done(Number.isFinite(n) ? n : undefined);
      });
    });
    return value === undefined ? null : value;
  }

  /** 最近一帧（可能文件已被轮换删掉，调用方自己兜 onError） */
  latest() {
    return this.shots[this.shots.length - 1];
  }

  async readLatest() {
    const latest = this.latest();
    if (!latest) return undefined;
    try {
      return await readFile(latest.file);
    } catch {
      return undefined;
    }
  }
}

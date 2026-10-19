# 停掉所有 dsh-pet-gpw 相关进程（含被 app.relaunch() 留下的孤儿），并确认 7341 已释放。
#
# 为什么要单独写：手工清理踩过坑 ——
#   过滤条件写成 "*gpw*" 时，命令行里只有 "...\gpw-main.cjs" 的进程会因为大小写/引号差异被漏掉，
#   于是"清干净了"其实还留着一个占着 7341，下一次启动直接 EADDRINUSE 然后页面加载失败。
#   这里改成对**完整命令行**做不区分大小写的包含匹配，并按端口占用反查兜底。
#
#   pwsh -File scripts/gpw-stop.ps1 [-Quiet]
param(
  [switch]$Quiet,
  # 只列出会停掉哪些进程，不真的停 —— 改过滤条件后先这样验一遍，别顺手杀了别人的鱼
  [switch]$DryRun
)

$ErrorActionPreference = 'SilentlyContinue'

function Say($msg) { if (-not $Quiet) { Write-Output $msg } }

# ① 按命令行匹配（含 electron 主进程/渲染/GPU 子进程，主进程一死子进程会跟着退）
#
# ⚠️ 匹配必须**精确到本仓库的入口路径**，不能用 'gpw-main' / 'dsh-pet-gpw' 这种子串：
#    另一份副本（OpenCode 那边）的进程是
#      G:\goh agent\dsh-pet-gpw-opencodeuntime\gpw-main.cjs
#    —— 'gpw-main' 与 'dsh-pet-gpw' 两个子串**都命中它**，于是这个停止脚本会顺手杀掉别人的鱼
#    （对方 2026-10-15 报过来的，实测确认）。这里改成脚本自己算包根 + 精确路径：
#    包根 = 本脚本所在目录的上一级（scripts/ 的 ..），与仓库放哪儿无关，也不写死盘符。
$packageRoot = Split-Path -Parent $PSScriptRoot
$entry = (Join-Path $packageRoot 'runtime\gpw-main.cjs').ToLower()
Say ("按入口匹配: " + $entry)
$targets = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($entry) }

# ② 按端口反查兜底（有些人/工具拉起的进程命令行可能不带这些字样）
$byPort = @()
foreach ($c in (Get-NetTCPConnection -LocalPort 7341 -State Listen -ErrorAction SilentlyContinue)) {
  if ($c.OwningProcess -gt 0) { $byPort += $c.OwningProcess }
}

$pids = @($targets.ProcessId) + $byPort | Sort-Object -Unique
if ($pids.Count -eq 0) {
  Say '没有需要停的副本进程'
} else {
  Say ("停止 " + $pids.Count + " 个进程: " + ($pids -join ', '))
  # ⚠️ 循环变量别叫 $id：PowerShell 变量名不区分大小写，$id 就是自动变量 $PID（当前进程，只读），
  #    那样写会变成"停止自己"或静默失败 —— 实战踩过，名字改成 $procId。
  foreach ($procId in $pids) {
    if ($DryRun) { Say ("  [DryRun] 会停 pid=" + $procId) ; continue }
    Stop-Process -Id $procId -Force
  }
}

# ③ 等端口真正释放（TIME_WAIT 不算占用；只等 Listen）
for ($i = 0; $i -lt 20; $i++) {
  $listen = Get-NetTCPConnection -LocalPort 7341 -State Listen -ErrorAction SilentlyContinue
  if (-not $listen) { break }
  Start-Sleep -Milliseconds 300
}

$still = Get-NetTCPConnection -LocalPort 7341 -State Listen -ErrorAction SilentlyContinue
if ($still) {
  Say ("⚠ 7341 仍被 pid=" + ($still.OwningProcess -join ',') + " 占用")
  exit 1
}
Say '7341 已释放'
exit 0

# 桌面快捷方式调的是这个。全程不出现任何窗口。
#
# 它只做两件事：
#   ① 把 toggle.ps1 藏起来跑 —— 由 toggle.ps1 决定这次是"启动"还是"停掉"；
#   ② 这次如果是"启动"、最后却没起来，弹个框说清楚为什么。
#      没有窗口的时候，失败是完全无声的 —— "点了没反应还不知道为什么"最难查，所以这步不能省。
#
# 为什么不让快捷方式直接指向 toggle.ps1：
#   toggle.ps1 是用「studyhelper 开关.bat」调的，双击 .bat 必然闪一个 cmd 黑框。
#   桌面快捷方式直接隐藏调用这个文件，黑框就不会出现。
#
# ⚠ 这个文件必须带 UTF-8 BOM：PowerShell 5.1 对无 BOM 的 .ps1 按本地代码页（GBK）读，
#   中文注释会被解成乱码、引号被吃掉，整个脚本解析失败，而且不一定报错。改完记得验一次。

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot          # …\studyhelper
$PORT = 5177
$log = Join-Path $root '.cache\server.log'

function Test-Up {
  try {
    return (@(Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue).Count -gt 0)
  } catch {
    return $false
  }
}

# 先记下"点之前"的状态：toggle.ps1 会按这个状态决定是启动还是停掉
$wasUp = Test-Up

$launchErr = $null
try {
  & (Join-Path $PSScriptRoot 'toggle.ps1')
} catch {
  $launchErr = $_.Exception.Message
}

# 这次是"停掉"，toggle.ps1 已经收摊了，没什么要确认的
if ($wasUp) { exit 0 }

# 这次是"启动"：确认它真的起来了。start-app.ps1 自己最多等 30 秒，
# 这里再给 20 秒兜底 —— 它失败时的那几行提示写在隐藏窗口里，你本来也看不见。
$up = $false
foreach ($i in 1..40) {
  if (Test-Up) { $up = $true; break }
  Start-Sleep -Milliseconds 500
}

if ($up) { exit 0 }

$tail = '（没有日志文件 —— 可能 node 都没跑起来。检查 node 在不在 PATH：在 cmd 里敲 node -v）'
if (Test-Path -LiteralPath $log) {
  $lines = @(Get-Content -LiteralPath $log -Tail 12 -Encoding UTF8)
  if ($lines.Count -gt 0) { $tail = $lines -join "`r`n" }
}

$msg = 'studyhelper 没起来。' + "`r`n`r`n" + '日志：' + $log + "`r`n`r`n" + '最后几行：' + "`r`n" + $tail
if ($launchErr) { $msg = $msg + "`r`n`r`n" + '启动脚本报的错：' + "`r`n" + $launchErr }

try {
  (New-Object -ComObject WScript.Shell).Popup($msg, 60, 'studyhelper 启动失败', 16) | Out-Null
} catch { }

exit 1

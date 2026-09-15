# 真身：把服务跑起来。被 start-app.ps1 用「隐藏窗口」拉起。
# 单独运行它也可以（会占住这个终端，Ctrl+C 结束）。
#
# ── 三条坑，改之前先看 ──
#   ① 【管道读取的编码】PowerShell 5.1 按**本地代码页**（中文机器上是 GBK）解码子进程
#      stdout 的字节。node 输出的是 UTF-8，所以 `node ... | ForEach-Object` 拿到手时
#      中文**已经是乱码了** —— 后面再怎么写文件都救不回来。必须先把
#      [Console]::OutputEncoding 设成 UTF-8（下面第一行），让它在解码那一刻就用对编码。
#   ② 【别用 `*>> log` 重定向】它同样按代码页解码，而且写的是 UTF-16，
#      和 `Get-Content` 的默认读法对不上（会看到空行/乱码交替）。
#   ③ 【这是 .ps1，必须带 UTF-8 BOM】没有 BOM 时 PowerShell 5.1 把中文按 GBK 读，
#      中文注释被解成乱码、引号被吃掉 → 整个脚本解析失败、什么都不做。
#      ⚠ 用普通文本编辑器改完这个文件，BOM 可能会掉。改完就跑一次 start-app 验证。
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Set-Location (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))

$log = Join-Path (Get-Location) '.cache\server.log'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null
$enc = New-Object System.Text.UTF8Encoding($false)

node server.js --no-open 2>&1 | ForEach-Object {
  [System.IO.File]::AppendAllText($log, [string]$_ + "`r`n", $enc)
}

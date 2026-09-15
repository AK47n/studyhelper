# studyhelper 启动器：起服务（无黑窗口）→ 等它真的能响应 → 开浏览器。
# 已有服务在跑时直接开浏览器，不会起第二个。
# 由「studyhelper 开关.bat」调用，双击桌面快捷方式走这条路。
#
# ⚠ 这个文件必须带 UTF-8 BOM（见 common.ps1 里的说明）。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)  # …\studyhelper
$url = 'http://127.0.0.1:5177/'
$log = Join-Path $root '.cache\server.log'   # .cache/ 已在 .gitignore 里，不会进仓库
$psExe = if (Test-Path 'C:\Program Files\PowerShell\7\pwsh.exe') { 'C:\Program Files\PowerShell\7\pwsh.exe' } else { 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' }

. "$PSScriptRoot\common.ps1"   # 找浏览器 → $script:BrowserExe

function Test-Up {
  try {
    return (Get-NetTCPConnection -LocalPort 5177 -State Listen -ErrorAction SilentlyContinue) -ne $null
  } catch { return $false }
}

# 关掉上一次留下的「已停止」提示窗口。
# 标题用**前缀**匹配 —— 浏览器会在页面标题后加自己的名字，实际是
#   studyhelper 已停止 - Google Chrome
# 所以精确相等永远匹配不上（实测踩到：提示窗口一直关不掉）。
# 再用 CloseMainWindow() 发正常关闭消息：不走键盘、不拿模糊标题乱匹配，
# 不会误关你别的标签页。找不到就什么都不做。
function Close-StoppedWindow {
  try {
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowTitle -like "$($script:StoppedTitlePrefix)*" } |
      ForEach-Object { [void]$_.CloseMainWindow() }
  } catch { }
}

function Open-App {
  # 有浏览器 exe 就用它（已在运行时 Chrome 会复用现有窗口，不会越开越多）；
  # 找不到就退回系统默认打开方式。
  if ($script:BrowserExe) {
    try { Start-Process -FilePath $script:BrowserExe -ArgumentList $url; return } catch { }
  }
  Start-Process $url
}

if (Test-Up) {
  Write-Host ''
  Write-Host '  服务已经在跑了，直接把页面打开。'
  Close-StoppedWindow
  Open-App
  Start-Sleep -Seconds 1
  exit 0
}

# 页面没构建过就先构建。
# 判断"构建过没有"不能只看 dist\index.html：构建中途失败会留下一个 index.html，
# 但它指向的 assets 可能没生成，页面照样是空的。所以要连 assets 一起看。
$distHtml = Join-Path $root 'dist\index.html'
$distAssets = Join-Path $root 'dist\assets'
$needBuild = (-not (Test-Path $distHtml)) -or (-not (Test-Path $distAssets)) -or `
  (@(Get-ChildItem -LiteralPath $distAssets -Filter '*.js' -ErrorAction SilentlyContinue).Count -eq 0)

if ($needBuild) {
  Write-Host ''
  Write-Host '  正在构建页面（第一次要十几秒）…'
  # ⚠ 不要用 Push-Location/Pop-Location 换目录再跑 npm。
  #   同样是实测踩到的坑：Push/Pop 没把"当前位置"还原，之后
  #   Start-Process -FilePath 会报 "current provider (Registry) cannot open a file"，
  #   报错位置看起来和换目录完全无关，极难查。所以这里改用 --prefix 指定目录，
  #   位置一动都不动。
  # ⚠ 另外 $ErrorActionPreference 要临时放成 Continue：本脚本开头设的是 Stop，
  #   而 PowerShell 会把**原生命令写到 stderr 的每一行**都当错误。vite 恰好会往 stderr
  #   打一条 "chunk 超过 500 kB" 的提示，Stop 会把它升级成终止性错误 ——
  #   实测表现为"构建退出码 0、dist 正常，脚本却报构建失败"。
  #   成败只看 $LASTEXITCODE（原生命令的真退出码），也不要 `| Out-Null` 让退出码走管道。
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & npm.cmd --prefix $root run build > $null 2>&1
    $buildCode = $LASTEXITCODE
  } catch {
    $buildCode = 1
  } finally {
    $ErrorActionPreference = $prevEap
  }
  if ($buildCode -ne 0) {
    Write-Host ''
    Write-Host '  ✗ 构建失败（npm run build 退出码' $buildCode '）'
    Write-Host '    先在本目录跑一次 npm install，再跑 npm run build 看具体报错。'
    Start-Sleep -Seconds 8
    exit 1
  }
}

Write-Host ''
Write-Host '  正在启动 studyhelper …'

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null
if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }

# 隐藏窗口起服务：这样桌面上不会多一个黑框。
# 代价是崩了你看不见报错 —— 所以下面要确认它真的起来了，并把日志留在 .cache\server.log
Start-Process -FilePath $psExe `
  -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'scripts\server-run.ps1') `
  -WindowStyle Hidden -WorkingDirectory $root

# 等端口真的能连上（最多 30 秒），起来了不等于能用
$ok = $false
foreach ($i in 1..60) {
  if (Test-Up) { $ok = $true; break }
  Start-Sleep -Milliseconds 500
}

if ($ok) {
  Write-Host '  服务已就绪：' $url
  Close-StoppedWindow
  try { Open-App } catch { Write-Host '  浏览器没打开，自己访问：' $url }
  Start-Sleep -Milliseconds 800
  exit 0
}

Write-Host ''
Write-Host '  ✗ 等 30 秒还没起来，服务可能启动失败了。'
Write-Host '    日志：' $log
if (Test-Path $log) {
  Write-Host '    最后几行：'
  Get-Content $log -Tail 8 | ForEach-Object { Write-Host '      ' $_ }
} else {
  Write-Host '    （没有日志文件，可能连 node 都没跑起来 —— 检查 node 在不在 PATH）'
}
Write-Host ''
Start-Sleep -Seconds 10
exit 1

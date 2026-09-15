# studyhelper 关闭器：杀掉占着 5177 的进程，再关掉浏览器里那个标签页。
# 由「studyhelper 开关.bat」调用 —— 服务开着的时候双击就是走这条路。
#
# ── 为什么不用 taskkill /F /T（这条最要紧）──
# 我们是用「隐藏窗口的 PowerShell」起 node 的：shell → powershell(server-run.ps1) → node。
# `/T` 会把整棵进程树杀光，包括往上不属于我们的人。实测踩过一次：
# 从 DSH 的命令行里调本脚本，`/T` 顺着进程链爬上去，**把调用它的那个 shell 也杀了**，
# 调用方直接拿到 exit code 4294967295（-1），后面的验证代码一行都没跑。
# 现在改成：只杀监听 5177 的那个进程本身，再单独清掉我们自己的外壳，
# 而且**先把本脚本的全部祖先 PID 拉进白名单，命中就跳过** —— 关服务绝不能把调用者带走。
$ErrorActionPreference = 'Continue'

# 白名单：从本进程往上一直到根，全部不许杀
$protected = New-Object System.Collections.Generic.HashSet[int]
$walk = $PID
for ($i = 0; $i -lt 16 -and $walk -gt 0; $i++) {
  [void]$protected.Add($walk)
  $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$walk" -ErrorAction SilentlyContinue).ParentProcessId
  if (-not $parent) { break }
  $walk = [int]$parent
}

$conns = @(Get-NetTCPConnection -LocalPort 5177 -State Listen -ErrorAction SilentlyContinue)
if ($conns.Count -eq 0) {
  Write-Host ''
  Write-Host '  studyhelper 本来就没在跑。'
  Write-Host ''
  exit 0
}

$killed = @()
foreach ($c in $conns) {
  $targetPid = [int]$c.OwningProcess
  if ($protected.Contains($targetPid)) {
    Write-Host '  ✗ 占着 5177 的就是我自己（或我的父进程），拒绝自杀，什么都没做。'
    Write-Host ''
    exit 1
  }
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  $killed += "$($proc.ProcessName) (PID $targetPid)"

  # 只杀它自己，不带 /T
  & taskkill /F /PID $targetPid > $null 2>&1
  if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) {
    Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
  }
}

# 清掉可能残留的外壳（不占端口，但会空转）。同样跳过白名单。
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match '-File\s+.*server-run\.ps1' } |
  ForEach-Object {
    if (-not $protected.Contains([int]$_.ProcessId)) {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }

# 确认端口真的放开了（别只说"已关闭"却还占着）
Start-Sleep -Milliseconds 500
$still = @(Get-NetTCPConnection -LocalPort 5177 -State Listen -ErrorAction SilentlyContinue).Count

Write-Host ''
if ($still -gt 0) {
  Write-Host '  ✗ 端口 5177 还被占着，没杀掉。可能是权限不够 —— 试试以管理员身份运行。'
  Write-Host ''
  exit 1
}
Write-Host ("  已停止服务：" + ($killed -join '、'))
Write-Host '  端口 5177 已释放，数据都保存好了。'

# ── 让浏览器显示"已停止" ──
# 最初想用 Ctrl+W 把标签页关掉。**试了 4 轮都没成功，放弃**：
#   · 激活没问题：SetForegroundWindow 返回 True、GetForegroundWindow 确认到了 Chrome；
#   · 键盘也没问题：同一手法发 Ctrl+T 能开出新标签、Ctrl+Tab 能切换标签；
#   · 但 Ctrl+W 就是不动标签页 —— Chrome 对"合成按键关标签"显然是专门挡掉的。
# 改成**导航到一张本地提示页**：不会误关你别的标签，而且不依赖任何按键，一定生效。
#
# 为什么不"复用已有标签"、而是每次新开一个：**Chrome 的窗口标题只反映当前活动标签**，
# 那个 studyhelper 标签多半在后台，标题里根本没有它 —— 判断不了它还在不在。
# 实测就是：明明有后台标签，标题匹配却失败。与其猜，不如给一个**确定的反馈**：
# 每次关服务都开一个「已停止」窗口摆在你面前，多余的那一下自己关掉就行。
. "$PSScriptRoot\common.ps1"   # 找浏览器 + 「已停止」页的标题/地址
$browserExe = $script:BrowserExe
$stoppedUrl = $script:StoppedUrl

if ($browserExe) {
  try {
    Start-Process -FilePath $browserExe -ArgumentList '--new-window', $stoppedUrl
    Write-Host '  已打开一个「已停止」的提示页（那个旧标签页自己关掉即可）。'
  } catch {
    Write-Host '  （提示页没打开，服务确实已经停了）'
  }
} else {
  Write-Host '  （没找到 Chrome/Edge，自己把标签页关掉即可；服务确实已经停了）'
}

Write-Host ''
exit 0

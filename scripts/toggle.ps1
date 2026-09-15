# 开关：服务没跑就启动（并打开页面），跑着就停掉（并关掉那个标签页）。
# 桌面快捷方式指向的就是「studyhelper 开关.bat」，它调这里。
# 判断依据只有一件事：5177 端口上有没有人在听。
$dir = $PSScriptRoot
$running = @(Get-NetTCPConnection -LocalPort 5177 -State Listen -ErrorAction SilentlyContinue).Count -gt 0

if ($running) {
  & (Join-Path $dir 'stop-app.ps1')
} else {
  & (Join-Path $dir 'start-app.ps1')
}

# 双击启动时能看到这几行；启动成功的话很快就退出了，不会杵着一个黑框
Start-Sleep -Seconds 2

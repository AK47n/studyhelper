# 启动器和关闭器共用的一小块：找浏览器、「已停止」提示页的地址。
# 用点号引用（. "$PSScriptRoot\common.ps1"）加载。
#
# ── 为什么不用 Get-ItemProperty 读注册表 ──
# 一开始用 PowerShell 的注册表 provider（HKLM:\...）。它会改变**当前"位置"**，
# 而这个文件是被 dot-source 的 —— 位置是共享的，于是调用方后面
#     Start-Process -FilePath ...
# 会报 "Cannot open file because the current provider (Registry) cannot open a file"。
# 试过在读之前 Push-Location / Pop-Location 包起来，**没用**：
# 实测在 -File 方式跑脚本时那个 Push/Pop 没能把位置还原，Start-Process 照样失败。
# 现在改用 .NET 的 Microsoft.Win32.Registry::GetValue —— 纯 API，压根不碰"位置"，
# 这类问题从根上不存在。
#
# ⚠ 也别用 $env:ProgramFiles 拼路径：在 DSH 这种受限 shell 里它可能是**空字符串**
#   （实测过），拼出来就是 "\Google\Chrome\..." 这种不存在的路径，于是误报"没找到浏览器"。
#
# ⚠ 这个文件必须带 UTF-8 BOM：PowerShell 5.1 对无 BOM 的 .ps1 按本地代码页（GBK）读，
#   中文注释会被解成乱码、引号被吃掉，整个文件解析失败。

$script:BrowserExe = $null
try {
  $appPaths = 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths'
  foreach ($exe in 'chrome.exe', 'msedge.exe') {
    foreach ($hive in @([Microsoft.Win32.Registry]::LocalMachine, [Microsoft.Win32.Registry]::CurrentUser)) {
      $p = [Microsoft.Win32.Registry]::GetValue("$($hive.Name)\$appPaths\$exe", '', $null)
      if ($p -and (Test-Path -LiteralPath $p)) { $script:BrowserExe = $p; break }
    }
    if ($script:BrowserExe) { break }
  }
} catch { }

if (-not $script:BrowserExe) {
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, "$env:LOCALAPPDATA") | Where-Object { $_ }
  foreach ($rel in 'Google\Chrome\Application\chrome.exe', 'Microsoft\Edge\Application\msedge.exe') {
    foreach ($r in $roots) {
      $cand = Join-Path $r $rel
      if (Test-Path -LiteralPath $cand) { $script:BrowserExe = $cand; break }
    }
    if ($script:BrowserExe) { break }
  }
}

# 「已停止」提示页：标题用**前缀**匹配，启动时靠它把上一次留下的提示窗口关掉。
# 注意不能要求"精确相等"：浏览器会在页面标题后面加自己的名字，实际标题是
#   studyhelper 已停止 - Google Chrome
# 所以只认"以 studyhelper 已停止 开头"的窗口。这个前缀足够长、足够独特，
# 不会误关你别的标签页（真正危险的是拿模糊标题去匹配无关窗口）。
$script:StoppedTitlePrefix = 'studyhelper 已停止'
$script:StoppedUrl = 'file:///' + ((Join-Path $PSScriptRoot 'stopped.html') -replace '\\', '/')

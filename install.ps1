# 一键安装 dsh-miaopeng-kit（自带 claude-style 外观和 WorkBuddy 模型）。用法（PowerShell）：
#   .\install.ps1                      # 自动查找安装目录（找不到时用 D:\dsh）
#   .\install.ps1 -App "E:\apps\dsh"   # 指定应用目录
#   .\install.ps1 -NoWindowPatch       # 不打窗口尺寸补丁
#   .\install.ps1 -Uninstall           # 卸载
param(
  [string]$App = "",
  [switch]$NoWindowPatch,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
if (-not $App) {
  # 安装器把位置登记在卸载信息里；装在哪个盘都能找到。
  $entry = Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall, HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall -ErrorAction SilentlyContinue |
    Get-ItemProperty | Where-Object { $_.DisplayName -like "DeepSeek Harness*" -and $_.InstallLocation } | Select-Object -First 1
  $App = if ($entry) { $entry.InstallLocation } else { "D:\dsh" }
}
$exe = Join-Path $App "DeepSeek Harness.exe"
if (-not (Test-Path $exe)) { throw "找不到 $exe，请用 -App 指定安装目录" }

# 必须完全退出（包括托盘），否则 app.asar 被占用、插件也不会重新加载。
Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$arguments = @((Join-Path $PSScriptRoot "scripts\install.mjs"), "--app", $App)
if ($NoWindowPatch) { $arguments += "--no-window-patch" }
if ($Uninstall) { $arguments += "--uninstall" }

# 应用本身就是 Electron，开 RunAsNode 即可当 Node 用，新机器不需要另装 Node。
$env:ELECTRON_RUN_AS_NODE = "1"
& $exe @arguments
$code = $LASTEXITCODE
Remove-Item Env:ELECTRON_RUN_AS_NODE
if ($code -ne 0) { throw "安装失败（退出码 $code）" }

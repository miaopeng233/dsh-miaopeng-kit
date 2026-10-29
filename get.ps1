# dsh-miaopeng-kit online installer (kept ASCII-only so `irm | iex` decodes it the same everywhere).
#   irm https://raw.githubusercontent.com/OWNER/dsh-miaopeng-kit/main/get.ps1 | iex
# With a custom app folder:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/OWNER/dsh-miaopeng-kit/main/get.ps1))) -App "E:\dsh"
param(
  [string]$Repo = "OWNER/dsh-miaopeng-kit",
  [string]$Ref = "main",
  [string]$App = ""
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# The source stays under ~/.dsh so install.ps1 can be re-run later (e.g. after an app update).
$source = Join-Path $env:USERPROFILE ".dsh\dsh-miaopeng-kit-src"
$zip = Join-Path $env:TEMP "dsh-miaopeng-kit.zip"
$staging = "$source.download"

Write-Host "Downloading $Repo@$Ref ..."
Invoke-WebRequest "https://codeload.github.com/$Repo/zip/refs/heads/$Ref" -OutFile $zip -UseBasicParsing
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip -DestinationPath $staging -Force
Remove-Item $source -Recurse -Force -ErrorAction SilentlyContinue
Move-Item (Get-ChildItem $staging | Select-Object -First 1).FullName $source
Remove-Item $staging, $zip -Recurse -Force -ErrorAction SilentlyContinue

# Run install.ps1 in a child PowerShell with -ExecutionPolicy Bypass: the default policy (Restricted /
# RemoteSigned plus the downloaded zip's mark-of-the-web) would otherwise refuse to run a local script.
Get-ChildItem $source -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
$shell = (Get-Process -Id $PID).Path
$arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $source "install.ps1"))
if ($App) { $arguments += @("-App", $App) }
& $shell @arguments
if ($LASTEXITCODE -ne 0) { throw "install.ps1 failed with exit code $LASTEXITCODE" }

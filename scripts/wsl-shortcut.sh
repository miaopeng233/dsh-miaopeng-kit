#!/usr/bin/env bash
# 在 Windows 桌面创建「DeepSeek Harness」快捷方式，启动 WSL 里的 dsh web（见 dsh-web-launch.sh）。
#
#   ./wsl-shortcut.sh                 创建 / 更新
#   ./wsl-shortcut.sh --remove        删除
#
# 图标：有 Windows 版留下的 icon.png（或 DSH_ICON_PNG 指定的 PNG）就转成 .ico 用，否则用 WSL 的图标。
set -euo pipefail
mode="${1:-}"

[[ -n "${WSL_DISTRO_NAME:-}" ]] || { echo "只能在 WSL 里运行" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="$HERE/dsh-web-launch.sh"
chmod +x "$LAUNCHER"

win_localappdata="$(powershell.exe -NoProfile -Command '[Environment]::GetFolderPath("LocalApplicationData")' | tr -d '\r')"
win_dir="$win_localappdata\\DeepSeekHarnessWSL"
lin_dir="$(wslpath -u "$win_dir")"
mkdir -p "$lin_dir"

icon_png="${DSH_ICON_PNG:-}"
if [[ -z "$icon_png" ]]; then
  app_png="$(wslpath -u "$win_localappdata")/Programs/DeepSeek Harness/resources/icon.png"
  [[ -f "$app_png" ]] && icon_png="$app_png"
fi
# 已经转好的 dsh.ico 会保留下来，所以 Windows 版卸载以后重建快捷方式图标也还在。
[[ -n "$icon_png" && -f "$icon_png" ]] && cp "$icon_png" "$lin_dir/icon-source.png"

# 参数里的 ~ 由 bash 展开；路径里没有空格时也加引号，换了用户名不会出错。
launcher_arg="${LAUNCHER/#$HOME/\~}"
ps="$lin_dir/make-shortcut.ps1"
cat > "$ps" <<EOF
\$ErrorActionPreference = 'Stop'
\$dir = '$win_dir'
\$ico = Join-Path \$dir 'dsh.ico'
\$src = Join-Path \$dir 'icon-source.png'
if (Test-Path \$src) {
  # 缩到 256×256 存成 PNG，再按 ICO 格式包一层（Vista 起 .ico 可以直接内嵌 PNG）。
  Add-Type -AssemblyName System.Drawing
  \$img = [System.Drawing.Image]::FromFile(\$src)
  \$bmp = New-Object System.Drawing.Bitmap 256, 256
  \$g = [System.Drawing.Graphics]::FromImage(\$bmp)
  \$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  \$g.DrawImage(\$img, 0, 0, 256, 256)
  \$g.Dispose(); \$img.Dispose()
  \$ms = New-Object System.IO.MemoryStream
  \$bmp.Save(\$ms, [System.Drawing.Imaging.ImageFormat]::Png); \$bmp.Dispose()
  \$png = \$ms.ToArray()
  \$out = New-Object System.IO.MemoryStream
  \$w = New-Object System.IO.BinaryWriter \$out
  \$w.Write([UInt16]0); \$w.Write([UInt16]1); \$w.Write([UInt16]1)
  \$w.Write([Byte]0); \$w.Write([Byte]0); \$w.Write([Byte]0); \$w.Write([Byte]0)
  \$w.Write([UInt16]1); \$w.Write([UInt16]32); \$w.Write([UInt32]\$png.Length); \$w.Write([UInt32]22)
  \$w.Write(\$png); \$w.Flush()
  [IO.File]::WriteAllBytes(\$ico, \$out.ToArray())
  Remove-Item \$src
}
\$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DeepSeek Harness.lnk'
if ('$mode' -eq '--remove') { Remove-Item \$lnk -ErrorAction SilentlyContinue; 'removed'; exit }
\$s = (New-Object -ComObject WScript.Shell).CreateShortcut(\$lnk)
\$s.TargetPath = Join-Path \$env:WINDIR 'System32\wsl.exe'
\$s.Arguments = '-d $WSL_DISTRO_NAME --cd ~ -- bash -lc "$launcher_arg"'
\$s.WindowStyle = 1   # 正常窗口：启动要 10～15 秒，最小化会让人以为没反应
\$s.Description = 'DeepSeek Harness（WSL）：启动 dsh web 并在浏览器打开'
if (Test-Path \$ico) { \$s.IconLocation = "\$ico,0" }
\$s.Save()
\$lnk
EOF
# Windows PowerShell 5.1 把没有 BOM 的脚本当 ANSI 读，中文说明会乱码。
{ printf '\xEF\xBB\xBF'; cat "$ps"; } > "$ps.bom" && mv "$ps.bom" "$ps"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$ps")" | tr -d '\r'
rm -f "$ps"

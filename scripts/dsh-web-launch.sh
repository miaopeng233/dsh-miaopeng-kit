#!/usr/bin/env bash
# 桌面快捷方式的启动器（WSL）：像桌面版一样「打开窗口 = 启动，关掉窗口 = 退出」。
#
#   1. dsh web 没在跑：后台启动它，等它打出带 token 的地址；
#   2. 用 Chrome / Edge 的应用模式开一个独立窗口（单独的浏览器配置目录，和日常浏览器互不影响）；
#   3. 等这个窗口全部关掉，停掉 dsh 后退出。没有任何进程留下，WSL 空闲一会儿后自己休眠，内存释放。
#
# 「窗口关没关」看的是连到 dsh 的浏览器连接：页面开着就一直连着服务端。连续 15 秒没有连接
# （留出刷新页面的余地）就算关了。从 WSL 启动的 chrome.exe 会把窗口交给另一个进程后马上返回，
# 等进程退出是等不到的；看连接还和浏览器无关，用默认浏览器打开也一样能自动退出。
#
# dsh 已经在跑（再次双击）：只再开一个窗口；退出仍由第一次启动的那个启动器负责。
#
# 环境变量：DSH_WEB_PORT（默认 3080）、DSH_NO_OPEN=1（测试：不开窗口）、DSH_BROWSER=default（用默认浏览器）
set -uo pipefail

PORT="${DSH_WEB_PORT:-3080}"
STATE="${DSH_HOME:-$HOME/.dsh}"
URL_FILE="$STATE/web-url"
LOG="$STATE/logs/web-launch.log"
mkdir -p "$STATE/logs"

listening() { curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/"; }

# 出错时弹个 Windows 提示框：快捷方式没有控制台窗口，否则用户什么都看不到。
alert() {
  printf '%s\n' "$1" >&2
  [[ -n "${DSH_NO_OPEN:-}" ]] && return 0
  local text="${1//\'/\'\'}"
  powershell.exe -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show('$text', 'DeepSeek Harness')" >/dev/null 2>&1 || true
}

LOCALAPPDATA_WIN="$(powershell.exe -NoProfile -Command '$env:LOCALAPPDATA' 2>/dev/null | tr -d '\r')"

app_browser() {
  [[ "${DSH_BROWSER:-}" == default ]] && return 1
  local candidate
  for candidate in \
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "$(wslpath -u "$LOCALAPPDATA_WIN" 2>/dev/null)/Google/Chrome/Application/chrome.exe" \
    "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
    "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe"; do
    [[ -f "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

# 开窗口（不阻塞）。单独的浏览器配置目录：不带日常浏览器的标签、扩展，窗口大小单独记忆。
open_window() {
  local url="$1" browser
  [[ -n "${DSH_NO_OPEN:-}" ]] && return 0
  if browser="$(app_browser)"; then
    setsid "$browser" --user-data-dir="$LOCALAPPDATA_WIN\\DeepSeekHarnessWSL\\browser" --no-first-run --no-default-browser-check \
      --app="$url" --window-size=1400,900 >/dev/null 2>&1 < /dev/null &
  else
    explorer.exe "$url" >/dev/null 2>&1 || true
  fi
}

# 当前连到 dsh 的浏览器连接数。
clients() { ss -Htn state established "( sport = :$PORT )" 2>/dev/null | wc -l; }

if listening; then
  url="$(cat "$URL_FILE" 2>/dev/null)"
  open_window "${url:-http://127.0.0.1:$PORT/}"
  exit 0
fi

command -v dsh >/dev/null || { alert "没找到 dsh。请先在 WSL 里运行 dsh-miaopeng-kit 的 install.sh。"; exit 1; }

rm -f "$URL_FILE"
: > "$LOG"
dsh web --no-open --port "$PORT" >> "$LOG" 2>&1 < /dev/null &
dsh_pid=$!
stop_dsh() {
  kill "$dsh_pid" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$dsh_pid" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$dsh_pid" 2>/dev/null
  rm -f "$URL_FILE"
}
trap 'stop_dsh; exit 0' INT TERM HUP

url=""
for _ in $(seq 1 180); do
  kill -0 "$dsh_pid" 2>/dev/null || break
  url="$(grep -oE 'dsh web: https?://[^[:space:]]+' "$LOG" | head -1 | cut -d' ' -f3)"
  [[ -n "$url" ]] && break
  sleep 0.5
done
if [[ -z "$url" ]]; then
  stop_dsh
  alert "DeepSeek Harness 启动失败。日志在 WSL 的 $LOG"
  exit 1
fi
printf '%s\n' "$url" > "$URL_FILE"
chmod 600 "$URL_FILE"

open_window "$url"

# 等窗口连上（最多 2 分钟），之后每 2 秒看一次，连续 15 秒没有连接就退出。
IDLE_LIMIT="${DSH_IDLE_SECONDS:-15}"
seen=0; idle=0; waited=0
while kill -0 "$dsh_pid" 2>/dev/null; do
  sleep 2
  if (( $(clients) > 0 )); then seen=1; idle=0; continue; fi
  if (( seen )); then
    idle=$((idle + 2))
    (( idle >= IDLE_LIMIT )) && break
  else
    waited=$((waited + 2))
    (( waited >= 120 )) && break   # 窗口一直没连上（被拦截 / 打不开）：别让 dsh 白白挂着
  fi
done
stop_dsh

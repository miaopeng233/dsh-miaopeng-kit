#!/usr/bin/env bash
# 桌面快捷方式的启动器（WSL）：dsh web 没在跑就在本窗口前台启动它，然后用 Windows 默认浏览器打开。
# 已经在跑就直接打开浏览器后退出。
#
# 故意让 dsh 留在这个（最小化的）窗口里前台运行，而不是丢到后台：WSL 在最后一个会话结束后
# 可能关掉整个发行版，后台进程会被悄悄杀掉。关掉这个窗口 = 退出 dsh。
set -uo pipefail

PORT="${DSH_WEB_PORT:-3080}"
STATE="${DSH_HOME:-$HOME/.dsh}"
URL_FILE="$STATE/web-url"

open_url() {
  [[ -n "${DSH_NO_OPEN:-}" ]] && return 0   # 测试用：不弹浏览器
  # explorer.exe 打开 URL 就是交给默认浏览器；它的退出码不可靠，忽略。
  explorer.exe "$1" >/dev/null 2>&1 || true
}

listening() { curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/"; }

if listening; then
  # 别处启动的 dsh 没有记录 token 时打开根地址：浏览器里已登录过的会话照样可用。
  url="$(cat "$URL_FILE" 2>/dev/null)"
  open_url "${url:-http://127.0.0.1:$PORT/}"
  exit 0
fi

command -v dsh >/dev/null || { echo "没找到 dsh：先运行 dsh-miaopeng-kit 的 install.sh" >&2; read -r -p "按回车关闭" _; exit 1; }

printf '\033]0;DeepSeek Harness（关闭此窗口即退出）\007'
echo "正在启动 DeepSeek Harness……关闭此窗口即退出。"
rm -f "$URL_FILE"
opened=""
dsh web --no-open --port "$PORT" 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line"
  if [[ -z "$opened" && "$line" =~ (https?://[^[:space:]]+) ]]; then
    opened=1
    printf '%s\n' "${BASH_REMATCH[1]}" > "$URL_FILE"
    chmod 600 "$URL_FILE"
    open_url "${BASH_REMATCH[1]}"
  fi
done
status=${PIPESTATUS[0]}
rm -f "$URL_FILE"
if [[ $status -ne 0 ]]; then
  echo "dsh 退出（代码 $status），详见上面的输出和 ~/.dsh/logs/。"
  read -r -p "按回车关闭" _
fi

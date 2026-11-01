#!/usr/bin/env bash
# dsh-miaopeng-kit 一键安装（WSL / Linux / macOS，npm 版 DeepSeek Harness）。
#
#   ./install.sh                         装 dsh（没装的话）+ pnpm + 本插件 + 额外插件 + 个人偏好
#   ./install.sh --migrate-from DIR      先从旧的 .dsh 目录搬凭据和设置，例如 /mnt/c/Users/mp/.dsh
#   ./install.sh --sessions              配合 --migrate-from，连会话历史一起搬
#   ./install.sh --no-extras --no-prefs  只装本插件
#   ./install.sh --uninstall             卸载本插件
#
# web_fetch 的 fake-ip 补丁（TUN 代理）不会自动打，需要的话装完单独运行：
#   node ~/.dsh/dsh-miaopeng-kit-src/scripts/patch-fakeip.mjs
set -euo pipefail

DSH_VERSION="${DSH_VERSION:-0.2.1-rc.5}"
PNPM_VERSION="${PNPM_VERSION:-11.28.5}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

migrate_from=""
sessions=""
pass=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --migrate-from) migrate_from="$2"; shift 2 ;;
    --sessions) sessions="--sessions"; shift ;;
    *) pass+=("$1"); shift ;;
  esac
done

need_node_major=22
if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < need_node_major )); then
  echo "需要 Node.js >= 22.19（推荐用 nvm：nvm install 24）" >&2
  exit 1
fi
# node-pty 要现场编译
if ! command -v make >/dev/null || ! command -v g++ >/dev/null; then
  echo "缺少编译工具：sudo apt install -y build-essential" >&2
  exit 1
fi

npm_g() { if [[ -w "$(npm config get prefix)/lib" ]]; then npm install -g "$@"; else sudo npm install -g "$@"; fi; }
command -v dsh >/dev/null || npm_g "@deepseek-ai/dsh@${DSH_VERSION}"
command -v pnpm >/dev/null || npm_g "pnpm@${PNPM_VERSION}"

# 运行中的 dsh 会占着 profile，先停掉
# 进程命令行是 `node /usr/local/bin/dsh web`（经 npm 的 bin 链接），按 bin 路径匹配。
DSH_BIN="$(command -v dsh)"
if pkill -f "^node ${DSH_BIN}( |$)|@deepseek-ai/dsh/lib/bin.js" 2>/dev/null; then
  echo "已停止运行中的 dsh，装完请重新运行 dsh web"
  sleep 2
fi

if [[ -n "$migrate_from" ]]; then
  node "$HERE/scripts/migrate.mjs" --from "$migrate_from" $sessions
fi
node "$HERE/scripts/install.mjs" "${pass[@]}"

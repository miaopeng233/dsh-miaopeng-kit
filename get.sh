#!/usr/bin/env bash
# dsh-miaopeng-kit 在线安装（WSL / Linux / macOS）：
#   curl -fsSL https://raw.githubusercontent.com/miaopeng233/dsh-miaopeng-kit/main/get.sh | bash
#   curl -fsSL .../get.sh | bash -s -- --migrate-from /mnt/c/Users/mp/.dsh   # 顺带搬 Windows 版的凭据和设置
# 源码放在 ~/.dsh/dsh-miaopeng-kit-src，以后在那里重跑 ./install.sh 即可。
set -euo pipefail
REPO="${REPO:-miaopeng233/dsh-miaopeng-kit}"
REF="${REF:-main}"
SRC="${DSH_HOME:-$HOME/.dsh}/dsh-miaopeng-kit-src"
if [[ -d "$SRC/.git" ]]; then
  git -C "$SRC" fetch --depth 1 origin "$REF" && git -C "$SRC" reset --hard FETCH_HEAD
else
  rm -rf "$SRC"
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$SRC"
fi
exec bash "$SRC/install.sh" "$@"

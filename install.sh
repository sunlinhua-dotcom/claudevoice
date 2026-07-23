#!/usr/bin/env bash
# ClaudeVoice GitHub 一键安装器
set -euo pipefail

REPO_URL="https://github.com/sunlinhua-dotcom/claudevoice.git"
RELEASE_API="https://api.github.com/repos/sunlinhua-dotcom/claudevoice/releases/latest"
INSTALL_DIR="${CLAUDEVOICE_DIR:-$HOME/ClaudeVoice}"
APP_DEST="/Applications/ClaudeVoice.app"
TTY_DEVICE=""
CV_INSTALL_TEMP=""

if [ -r /dev/tty ] && [ -w /dev/tty ]; then
  TTY_DEVICE="/dev/tty"
fi

fail() {
  echo "✗ $*" >&2
  exit 1
}

cleanup() {
  case "$CV_INSTALL_TEMP" in
    "${TMPDIR:-/tmp}"/claudevoice-install.*|/tmp/claudevoice-install.*)
      [ ! -d "$CV_INSTALL_TEMP" ] || rm -rf -- "$CV_INSTALL_TEMP"
      ;;
  esac
}
trap cleanup EXIT

echo "ClaudeVoice 一键安装"
echo "===================="

command -v git >/dev/null 2>&1 || fail "缺少 git。macOS 请先运行 xcode-select --install；其他系统请用包管理器安装 Git。"
command -v node >/dev/null 2>&1 || fail "缺少 Node.js。请安装 Node 14 或更高版本：https://nodejs.org/"

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 14 ]; then
  fail "当前 Node.js 是 $(node -v)，ClaudeVoice 需要 Node 14 或更高版本：https://nodejs.org/"
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  ORIGIN="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
  case "$ORIGIN" in
    *sunlinhua-dotcom/claudevoice*) ;;
    *) fail "$INSTALL_DIR 已是 Git 仓库，但不是 ClaudeVoice（origin: ${ORIGIN:-未知}）。请换目录或设置 CLAUDEVOICE_DIR。" ;;
  esac
  echo "== 更新已有仓库：$INSTALL_DIR =="
  git -C "$INSTALL_DIR" pull --ff-only
elif [ -e "$INSTALL_DIR" ] && [ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  fail "$INSTALL_DIR 已存在且不是空目录。请移走它，或设置 CLAUDEVOICE_DIR 指向其他目录。"
else
  echo "== 下载 ClaudeVoice 到：$INSTALL_DIR =="
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

echo "== 安装全局 hooks 与本机配置 =="
if [ -n "$TTY_DEVICE" ]; then
  (cd "$INSTALL_DIR" && node setup.js <"$TTY_DEVICE")
else
  echo "ℹ 当前没有交互终端，setup.js 将使用默认“仅本机”配置。"
  (cd "$INSTALL_DIR" && node setup.js </dev/null)
fi

install_macos_app() {
  command -v curl >/dev/null 2>&1 || {
    echo "⚠ 找不到 curl，跳过预编译 App 下载。"
    return 1
  }

  local temp_dir release_json asset_url source_app
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/claudevoice-install.XXXXXX")"
  CV_INSTALL_TEMP="$temp_dir"
  release_json="$temp_dir/release.json"

  if ! curl -fsSL --connect-timeout 10 --max-time 30 "$RELEASE_API" -o "$release_json"; then
    echo "⚠ 暂时没有可下载的 GitHub Release，或 GitHub API 当前不可用。"
    return 1
  fi

  asset_url="$(node -e '
    const fs = require("fs");
    const release = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const asset = (release.assets || []).find((item) => item.name === "ClaudeVoice.app.zip");
    if (asset && asset.browser_download_url) process.stdout.write(asset.browser_download_url);
  ' "$release_json" 2>/dev/null || true)"
  if [ -z "$asset_url" ]; then
    echo "⚠ 最新 Release 还没有 ClaudeVoice.app.zip。"
    return 1
  fi

  echo "== 下载预编译 ClaudeVoice.app =="
  curl -fL --connect-timeout 10 --max-time 180 "$asset_url" -o "$temp_dir/ClaudeVoice.app.zip"
  ditto -x -k "$temp_dir/ClaudeVoice.app.zip" "$temp_dir/unpacked"
  source_app="$temp_dir/unpacked/ClaudeVoice.app"
  if [ ! -d "$source_app" ]; then
    echo "⚠ Release 压缩包内没有 ClaudeVoice.app，已跳过安装。"
    return 1
  fi

  echo "== 安装到 $APP_DEST =="
  if ditto "$source_app" "$APP_DEST" 2>/dev/null; then
    :
  elif command -v sudo >/dev/null 2>&1; then
    echo "需要管理员权限写入 /Applications。"
    sudo ditto "$source_app" "$APP_DEST"
  else
    echo "⚠ 无权写入 /Applications，已跳过 App 安装。"
    return 1
  fi

  if ! xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null; then
    sudo xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true
  fi
  echo "✓ 已安装 $APP_DEST（不会自动启动或重启）。"
}

if [ "$(uname -s)" = "Darwin" ] && [ -n "$TTY_DEVICE" ]; then
  printf '\n要不要安装 macOS 菜单栏 App？[Y/n] ' >"$TTY_DEVICE"
  IFS= read -r APP_ANSWER <"$TTY_DEVICE" || APP_ANSWER=""
  if [ -z "$APP_ANSWER" ] || [[ "$APP_ANSWER" =~ ^[Yy]([Ee][Ss])?$ ]]; then
    if ! install_macos_app; then
      if command -v swiftc >/dev/null 2>&1; then
        echo "  你也可以稍后本地编译：cd \"$INSTALL_DIR/mac-app\" && ./build.sh"
      else
        echo "  当前也未检测到 swiftc；可等 Release 发布后重跑本安装命令。"
      fi
    fi
  else
    echo "已跳过菜单栏 App。"
  fi
elif [ "$(uname -s)" = "Darwin" ]; then
  echo "ℹ 非交互模式下不自动安装 /Applications；稍后可从 Releases 下载 App。"
fi

PORT="$(node -e '
  const fs = require("fs");
  let port = "8787";
  try {
    const line = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/).find((s) => /^PORT=/.test(s));
    if (line) port = line.slice(5).trim() || port;
  } catch (_) {}
  process.stdout.write(port);
' "$INSTALL_DIR/.env")"

echo ""
echo "================ 安装完成 ================"
echo "1) 启动服务：cd \"$INSTALL_DIR\" && node server.js"
echo "2) 打开面板：http://localhost:$PORT"
echo "3) 新开一个 Claude Code 会话，完成一条简单任务测试播报"
echo "=========================================="

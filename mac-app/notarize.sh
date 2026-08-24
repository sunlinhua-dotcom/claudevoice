#!/usr/bin/env bash
# 公证 ClaudeVoice.app —— 公证之后才能拿到 macOS 的本地通知权限，
# 新项目读音就能用系统原生横幅（自带回复输入框）来问，而不是自绘面板。
#
# 只需要做一次的准备（这一步涉及你的 Apple 凭据，必须你本人跑）：
#
#   1. 去 https://appleid.apple.com → 登录与安全 → App 专用密码 → 生成一个，
#      记下形如 abcd-efgh-ijkl-mnop 的密码。
#   2. 把它存进钥匙串（存完就不用再输了）：
#
#        xcrun notarytool store-credentials claudevoice \
#          --apple-id <你的 Apple ID 邮箱> \
#          --team-id 5PYXL3CQNR \
#          --password <上一步的 App 专用密码>
#
# 之后每次要公证，跑这个脚本就行：./notarize.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
PROFILE="${CV_NOTARY_PROFILE:-claudevoice}"
APP="${CV_APP_PATH:-/Applications/ClaudeVoice.app}"

command -v xcrun >/dev/null || { echo "✗ 找不到 xcrun，需要装 Xcode 或命令行工具"; exit 1; }
xcrun --find notarytool >/dev/null 2>&1 || { echo "✗ 找不到 notarytool，需要 Xcode 13+"; exit 1; }

if ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  echo "✗ 钥匙串里没有名为「$PROFILE」的公证凭据。"
  echo "  先跑一次（把尖括号换成你自己的）："
  echo ""
  echo "    xcrun notarytool store-credentials $PROFILE \\"
  echo "      --apple-id <你的 Apple ID 邮箱> \\"
  echo "      --team-id 5PYXL3CQNR \\"
  echo "      --password <App 专用密码>"
  echo ""
  echo "  App 专用密码在 https://appleid.apple.com → 登录与安全 → App 专用密码 生成。"
  exit 1
fi

echo "== 用 Developer ID 重新编译并签名（Hardened Runtime + 时间戳）=="
CV_USE_DEVID=1 ./build.sh

echo "== 打包 =="
ZIP="$(mktemp -d)/ClaudeVoice.zip"
ditto -c -k --keepParent "$APP" "$ZIP"

echo "== 提交公证（第一次通常几分钟）=="
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait

echo "== 装订公证票据 =="
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

echo "== 校验 =="
spctl -a -t exec -vv "$APP" 2>&1 | sed 's/^/  /'

echo ""
echo "================ 公证完成 ================"
echo "重启 App 后，新项目读音会改用系统原生通知横幅来问（横幅上直接回复）。"
echo ""
echo "注意：签名从自签名换成了 Developer ID，macOS 的权限是绑签名的，"
echo "所以「辅助功能」和「设备控制和数据访问」里的 ClaudeVoice 会失配，"
echo "需要重新授权一次：系统设置 → 隐私与安全性 → 对应项里把 ClaudeVoice"
echo "用「−」删掉，再启动 App 按提示允许一次即可（只需做这一次）。"
echo "=========================================="

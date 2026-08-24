#!/usr/bin/env bash
# 公证 ClaudeVoice.app —— 公证之后 macOS 才给本地通知权限，新项目读音
# 就能用系统原生横幅（自带回复输入框）来问，而不是自绘面板。
#
# 用法：./notarize.sh
#
# 第一次跑会问两个问题（Apple ID 邮箱 + App 专用密码），存进钥匙串之后
# 就再也不问了。App 专用密码在 https://appleid.apple.com → 登录与安全
# → App 专用密码 生成，不是 Apple ID 的登录密码。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
PROFILE="${CV_NOTARY_PROFILE:-claudevoice}"
APP="${CV_APP_PATH:-/Applications/ClaudeVoice.app}"
TEAM_ID="${CV_TEAM_ID:-5PYXL3CQNR}"

command -v xcrun >/dev/null || { echo "✗ 找不到 xcrun，需要装 Xcode 或命令行工具"; exit 1; }
xcrun --find notarytool >/dev/null 2>&1 || { echo "✗ 找不到 notarytool，需要 Xcode 13+"; exit 1; }

# 没存过凭据就当场问，问完直接存。密码用 read -s 读，不回显、不进 shell 历史。
if ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  echo "首次公证，先存一次凭据（只需这一次，之后再跑本脚本就直接公证）。"
  echo ""
  echo "如果还没有 App 专用密码：去 https://appleid.apple.com → 登录与安全"
  echo "→ App 专用密码 → 生成一个，形如 abcd-efgh-ijkl-mnop。"
  echo ""
  printf "① 你的 Apple ID 邮箱：" ; read -r CV_APPLE_ID
  [ -n "$CV_APPLE_ID" ] || { echo "✗ 邮箱不能为空"; exit 1; }
  printf "② App 专用密码（输入时不显示，粘贴后直接回车）：" ; read -rs CV_APP_PW ; echo ""
  [ -n "$CV_APP_PW" ] || { echo "✗ 密码不能为空"; exit 1; }
  echo ""
  echo "正在验证并存入钥匙串…"
  if ! xcrun notarytool store-credentials "$PROFILE" \
        --apple-id "$CV_APPLE_ID" --team-id "$TEAM_ID" --password "$CV_APP_PW"; then
    echo ""
    echo "✗ 验证没过。常见原因：邮箱不是这个开发者账号的 Apple ID，"
    echo "  或者密码用成了 Apple ID 登录密码（必须是 App 专用密码）。"
    exit 1
  fi
  unset CV_APP_PW
  echo "✓ 凭据已存好，继续公证。"
  echo ""
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
echo ""
printf "现在就打开那个设置面板吗？[Y/n] " ; read -r ANS
case "${ANS:-Y}" in
  [Yy]*|"") open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" ;;
esac

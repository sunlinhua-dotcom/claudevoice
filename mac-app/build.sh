#!/bin/bash
# 编译并打包 ClaudeVoice.app（菜单栏 + Dock）
set -e
cd "$(dirname "$0")"
APP="${CV_APP_PATH:-/Applications/ClaudeVoice.app}"

echo "== 编译 Swift =="
# 注意：本机 Swift 工具链默认 target 是 macosx28.0（比在跑的系统还高），
# 不显式指定 -target 的话，编译出的二进制 minos=28.0，会被 LaunchServices 拒绝启动。
# 这里把部署目标钉到 13.0，与下面 Info.plist 的 LSMinimumSystemVersion 保持一致。
case "$(uname -m)" in
  arm64) CV_ARCH=arm64 ;;
  *)     CV_ARCH=x86_64 ;;
esac
SWIFT_SOURCES=(main.swift)
for src in *.swift; do
  [ "$src" = "main.swift" ] && continue
  SWIFT_SOURCES+=("$src")
done
swiftc "${SWIFT_SOURCES[@]}" -o ClaudeVoice -target "${CV_ARCH}-apple-macos13.0" \
  -framework Cocoa -framework ServiceManagement -framework ApplicationServices \
  -framework Carbon -framework CoreImage -swift-version 5 -O

echo "== 组装 .app =="
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp ClaudeVoice "$APP/Contents/MacOS/ClaudeVoice"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp menubar.png  "$APP/Contents/Resources/menubar.png"
cp chime-done.wav chime-alert.wav "$APP/Contents/Resources/" 2>/dev/null || true
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>ClaudeVoice</string>
  <key>CFBundleDisplayName</key><string>ClaudeVoice</string>
  <key>CFBundleIdentifier</key><string>com.claudevoice.app</string>
  <key>CFBundleExecutable</key><string>ClaudeVoice</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

echo "== 签名 =="
# 优先用稳定的自签名证书签名：TCC 的辅助功能授权会绑定 designated requirement。
# 同一证书反复重编译后 DR 稳定；证书不可用时回退 ad-hoc，授权可能随重编译失效。
RV_KEYCHAIN="$HOME/Library/Keychains/remotevoice-signing.keychain-db"
RV_SIGN_ID="${RV_SIGN_ID:-RemoteVoice Local Signing}"
RV_KCPASS="${RV_KCPASS:-rvlocal-signing}"
if [ -f "$RV_KEYCHAIN" ]; then
  security unlock-keychain -p "$RV_KCPASS" "$RV_KEYCHAIN" 2>/dev/null || true
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$RV_KCPASS" "$RV_KEYCHAIN" >/dev/null 2>&1 || true
fi
if [ -f "$RV_KEYCHAIN" ] && codesign --force --deep --keychain "$RV_KEYCHAIN" --sign "$RV_SIGN_ID" --identifier com.claudevoice.app "$APP" 2>/dev/null; then
  echo "  已用稳定自签名身份：$RV_SIGN_ID"
else
  echo "  稳定证书不可用，回退 ad-hoc（辅助功能授权可能随每次重编译失效）"
  codesign --force --deep --sign - --identifier com.claudevoice.app "$APP"
fi

echo "== 完成：$APP =="

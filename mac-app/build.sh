#!/bin/bash
# 编译并打包 ClaudeVoice.app（菜单栏 + Dock）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NO_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --no-install) NO_INSTALL=1 ;;
    *) echo "未知参数：$arg"; echo "用法：./build.sh [--no-install]"; exit 2 ;;
  esac
done

CV_ARCH="${CV_ARCH:-$(uname -m)}"
case "$CV_ARCH" in
  arm64|x86_64) ;;
  *) echo "不支持的 CV_ARCH：$CV_ARCH（只支持 arm64 / x86_64）"; exit 2 ;;
esac

if [ "$NO_INSTALL" -eq 1 ]; then
  BUILD_ROOT="${OUT_DIR:-$SCRIPT_DIR/build}"
  mkdir -p "$BUILD_ROOT"
  APP="$BUILD_ROOT/ClaudeVoice.app"
  BINARY="$BUILD_ROOT/ClaudeVoice-$CV_ARCH"
else
  APP="${CV_APP_PATH:-/Applications/ClaudeVoice.app}"
  TEMP_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/claudevoice-build.XXXXXX")"
  trap 'rm -rf "$TEMP_BUILD"' EXIT
  BINARY="$TEMP_BUILD/ClaudeVoice-$CV_ARCH"
fi

case "$APP" in
  ""|"/"|"$HOME") echo "拒绝使用不安全的 App 输出路径：$APP"; exit 2 ;;
esac

cd "$SCRIPT_DIR"
echo "== 编译 Swift ($CV_ARCH) =="
# 注意：本机 Swift 工具链默认 target 可能比在跑的系统还高。
# 绝对保留显式 target，与 Info.plist 的 LSMinimumSystemVersion 保持一致。
MODULE_CACHE_ROOT="${CV_MODULE_CACHE_DIR:-$(dirname "$BINARY")/.module-cache}"
mkdir -p "$MODULE_CACHE_ROOT/clang" "$MODULE_CACHE_ROOT/swift"
SWIFT_SOURCES=(main.swift)
for src in *.swift; do
  [ "$src" = "main.swift" ] && continue
  SWIFT_SOURCES+=("$src")
done
CLANG_MODULE_CACHE_PATH="$MODULE_CACHE_ROOT/clang" \
SWIFT_MODULECACHE_PATH="$MODULE_CACHE_ROOT/swift" \
swiftc "${SWIFT_SOURCES[@]}" -o "$BINARY" -target "${CV_ARCH}-apple-macos13.0" \
  -framework Cocoa -framework ServiceManagement -framework ApplicationServices \
  -framework Carbon -framework CoreImage -swift-version 5 -O

echo "== 组装 .app =="
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BINARY" "$APP/Contents/MacOS/ClaudeVoice"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp menubar.png "$APP/Contents/Resources/menubar.png"
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
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
  <key>DTPlatformName</key><string>macosx</string>
  <key>DTSDKName</key><string>macosx14.0</string>
</dict></plist>
PLIST

echo "== 签名 =="
# 优先 Developer ID：只有带 TeamIdentifier 的签名才拿得到系统通知权限，
# 自签名会被 UNUserNotificationCenter 直接拒（Notifications are not allowed
# for this application）。没有 Developer ID 时退回本地自签名，再退 ad-hoc。
# 默认仍用本地自签名：换签名会让 macOS 的辅助功能 / 设备控制授权失配，
# 每次启动都重新弹框要权限。而 Developer ID 只有在 App 也做了公证之后
# 才换得到系统通知权限（实测未公证一样被拒），所以不值得默认切换。
# 真要走原生通知：先 notarytool 公证，再 CV_USE_DEVID=1 ./build.sh。
if [ "${CV_USE_DEVID:-0}" = "1" ]; then
  DEVID="${CV_SIGN_ID:-$(security find-identity -v -p codesigning 2>/dev/null \
    | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"')}"
else
  DEVID=""
fi
RV_KEYCHAIN="$HOME/Library/Keychains/remotevoice-signing.keychain-db"
RV_SIGN_ID="${RV_SIGN_ID:-RemoteVoice Local Signing}"
RV_KCPASS="${RV_KCPASS:-rvlocal-signing}"
if [ -n "$DEVID" ] && codesign --force --deep --sign "$DEVID" --identifier com.claudevoice.app "$APP" 2>/dev/null; then
  echo "  已用 Developer ID 签名：$DEVID"
else
  if [ -f "$RV_KEYCHAIN" ]; then
    security unlock-keychain -p "$RV_KCPASS" "$RV_KEYCHAIN" 2>/dev/null || true
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$RV_KCPASS" "$RV_KEYCHAIN" >/dev/null 2>&1 || true
  fi
  if [ -f "$RV_KEYCHAIN" ] && codesign --force --deep --keychain "$RV_KEYCHAIN" --sign "$RV_SIGN_ID" --identifier com.claudevoice.app "$APP" 2>/dev/null; then
    echo "  没有 Developer ID，用稳定自签名身份：$RV_SIGN_ID（系统通知会不可用，退回自绘面板）"
  else
    echo "  稳定证书不可用，回退 ad-hoc（系统通知会不可用，退回自绘面板）"
    codesign --force --deep --sign - --identifier com.claudevoice.app "$APP"
  fi
fi

if [ "$NO_INSTALL" -eq 1 ]; then
  echo "== 完成（未安装、未重启）：$APP =="
else
  echo "== 完成：$APP =="
fi

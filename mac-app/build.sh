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
</dict></plist>
PLIST

echo "== 签名 =="
# 优先用稳定的自签名证书签名；不可用时（包括 CI）回退 ad-hoc。
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
  echo "  稳定证书不可用，回退 ad-hoc"
  codesign --force --deep --sign - --identifier com.claudevoice.app "$APP"
fi

if [ "$NO_INSTALL" -eq 1 ]; then
  echo "== 完成（未安装、未重启）：$APP =="
else
  echo "== 完成：$APP =="
fi

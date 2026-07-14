#!/bin/bash
# 编译并打包 ClaudeVoice.app（菜单栏 + Dock）
set -e
cd "$(dirname "$0")"
APP="/Applications/ClaudeVoice.app"

echo "== 编译 Swift =="
swiftc main.swift -o ClaudeVoice -framework Cocoa -framework ServiceManagement -swift-version 5 -O

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

echo "== ad-hoc 签名（未签名 App 在新版 macOS 上要签一下才稳）=="
codesign --force --deep --sign - "$APP" 2>/dev/null && echo "  已签名" || echo "  签名跳过"

echo "== 完成：$APP =="

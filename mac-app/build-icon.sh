#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

SRC="../bridge/assets/src/app-icon.png"
BASE="AppIcon-1024.png"
ICONSET="AppIcon.iconset"

command -v magick >/dev/null || { echo "缺少 ImageMagick magick" >&2; exit 1; }
magick "$SRC" -resize 1024x1024! -alpha set \
  \( +clone -alpha transparent -fill white -draw "roundrectangle 0,0 1023,1023 218,218" \) \
  -compose DstIn -composite "$BASE"

rm -rf "$ICONSET"
mkdir -p "$ICONSET"
make_icon() { sips -z "$1" "$1" "$BASE" --out "$ICONSET/$2" >/dev/null; }
make_icon 16 icon_16x16.png
make_icon 32 icon_16x16@2x.png
make_icon 32 icon_32x32.png
make_icon 64 icon_32x32@2x.png
make_icon 128 icon_128x128.png
make_icon 256 icon_128x128@2x.png
make_icon 256 icon_256x256.png
make_icon 512 icon_256x256@2x.png
make_icon 512 icon_512x512.png
make_icon 1024 icon_512x512@2x.png
if ! iconutil -c icns "$ICONSET" -o AppIcon.icns; then
  echo "iconutil 无法编码当前系统上的 iconset，改用等价的 PNG-ICNS 容器打包" >&2
  node pack-icns.mjs "$ICONSET" AppIcon.icns
fi
echo "已生成 $(pwd)/AppIcon.icns"

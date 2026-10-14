#!/bin/zsh
set -e
cd "${0:A:h}/.."
iconset="build/mailai.iconset"
mkdir -p "$iconset"
source_icon="app/web/static/assets/mailai-app-icon-1024.png"
icon_hash="$(shasum -a 256 "$source_icon" | cut -c1-12)"
target_icon="build/mailai-${icon_hash}.icns"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$source_icon" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$source_icon" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$target_icon"
echo "Generated $target_icon"

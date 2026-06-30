#!/bin/bash
# 将 supersplat dist/ 产物复制到 Vortex 的 examples/gaussian/splat-editor/
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="/Users/wzw/Documents/work/vortex/packages/vortex/examples/gaussian/splat-editor"

if [ ! -d "$SCRIPT_DIR/dist" ]; then
    echo "❌ dist/ 目录不存在，请先执行 npm run build"
    exit 1
fi

echo "📦 复制 supersplat dist/ → Vortex examples/gaussian/splat-editor/"
rm -rf "$TARGET"/*
cp -r "$SCRIPT_DIR/dist"/* "$TARGET"/
echo "✅ 复制完成"

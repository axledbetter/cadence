#!/usr/bin/env bash
# marketing/render.sh — composite title card + core terminal demo + outro card
# + bottom-right watermark.
#
# Requires: vhs, ffmpeg, ImageMagick (magick).
#
# Usage:
#   bash marketing/render.sh

set -euo pipefail
cd "$(dirname "$0")/.."

W=1200
H=700

mkdir -p marketing/_build

echo "[1/5] Rendering core terminal demo via VHS..."
vhs marketing/demo.tape > /dev/null

echo "[2/5] Generating title card..."
magick -size "${W}x${H}" "xc:#1a1b26" \
  -font /System/Library/Fonts/SFNSMono.ttf \
  -gravity center \
  -fill "#c0caf5" -pointsize 64 -annotate +0-30 "Cadence" \
  -fill "#7aa2f7" -pointsize 22 -annotate +0+30 "the multi-model automated coding harness" \
  -fill "#565f89" -pointsize 16 -annotate +0+80 "v8.4.0  .  @delegance/cadence  .  MIT" \
  marketing/_build/title.png

echo "[3/5] Generating outro card..."
magick -size "${W}x${H}" "xc:#1a1b26" \
  -font /System/Library/Fonts/SFNSMono.ttf \
  -gravity center \
  -fill "#c0caf5" -pointsize 28 -annotate +0-60 "npm install -g @delegance/cadence" \
  -fill "#7aa2f7" -pointsize 22 -annotate +0+10 "github.com/axledbetter/cadence" \
  -fill "#565f89" -pointsize 16 -annotate +0+70 "MIT  .  16+ providers  .  concurrent multi-PR dispatch" \
  marketing/_build/outro.png

echo "[4/5] Converting cards to MP4 clips..."
CORE_FPS=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 marketing/demo-core.mp4 | head -1)
ffmpeg -y -loop 1 -t 1.5 -i marketing/_build/title.png \
  -vf "fps=${CORE_FPS},format=yuv420p,scale=${W}:${H}" \
  -c:v libx264 -preset slow -crf 18 \
  marketing/_build/title.mp4 2>/dev/null

ffmpeg -y -loop 1 -t 2.0 -i marketing/_build/outro.png \
  -vf "fps=${CORE_FPS},format=yuv420p,scale=${W}:${H}" \
  -c:v libx264 -preset slow -crf 18 \
  marketing/_build/outro.mp4 2>/dev/null

magick -size 200x32 xc:none \
  -fill "#c0caf5aa" \
  -font /System/Library/Fonts/SFNSMono.ttf \
  -pointsize 14 \
  -gravity east \
  -annotate +12+0 "cadence . v8.4.0" \
  marketing/_build/watermark.png

echo "[5/5] Compositing final MP4 + GIF..."
cat > marketing/_build/concat.txt <<EOF
file 'title.mp4'
file '../demo-core.mp4'
file 'outro.mp4'
EOF

ffmpeg -y -f concat -safe 0 -i marketing/_build/concat.txt \
  -c copy \
  marketing/_build/concat.mp4 2>/dev/null

ffmpeg -y -i marketing/_build/concat.mp4 -i marketing/_build/watermark.png \
  -filter_complex "[0:v][1:v] overlay=W-w-12:H-h-12" \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
  -movflags +faststart \
  marketing/demo.mp4 2>/dev/null

ffmpeg -y -i marketing/demo.mp4 -vf "fps=15,scale=${W}:-1:flags=lanczos,palettegen=stats_mode=diff" \
  marketing/_build/palette.png 2>/dev/null

ffmpeg -y -i marketing/demo.mp4 -i marketing/_build/palette.png \
  -filter_complex "fps=15,scale=${W}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop 0 \
  marketing/demo.gif 2>/dev/null

echo ""
echo "Done."
ls -lah marketing/demo.mp4 marketing/demo.gif
echo ""
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 marketing/demo.mp4 | awk '{printf "Duration: %.1f sec\n", $1}'

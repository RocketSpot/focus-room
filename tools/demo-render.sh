#!/bin/zsh
# ============================================================
# demo-render.sh, assemble the captured frames into the 2:1 demo film.
# ------------------------------------------------------------
# Layout, 2400x1200 (exactly 2:1):
#   LEFT  1600x1200 : the TV, 1600x900 centred with the room's black above/below
#   RIGHT  800x1200 : the iPad, 800x1149 centred
#   CUTS            : the operator console fills the frame during the windows
#                     listed in edit.json, so the film shows the menu in use
#
# Run after tools/demo-capture.js:   tools/demo-render.sh
# ============================================================
set -e
ROOT="/Users/neurotech/focus-room"
D="$ROOT/data/demo"
OUTFILE="${1:-$ROOT/data/demo/focus-room-demo.mp4}"
FPS=$(python3 -c "import json;print(json.load(open('$D/edit.json'))['fps'])")

# turn the cut frame list into ffmpeg enable= expressions (seconds)
ENABLE=$(python3 - "$D/edit.json" "$FPS" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); fps = float(sys.argv[2])
cuts = sorted(d["cuts"])
runs, start, prev = [], None, None
for f in cuts:
    if start is None: start = prev = f; continue
    if f == prev + 1: prev = f; continue
    runs.append((start, prev)); start = prev = f
if start is not None: runs.append((start, prev))
print("+".join(f"between(t,{a/fps:.3f},{(b+1)/fps:.3f})" for a, b in runs) or "0")
PY
)

echo "  fps=$FPS  ops cutaways: $ENABLE"

ffmpeg -y -loglevel error -stats \
  -framerate "$FPS" -i "$D/tv/%05d.png" \
  -framerate "$FPS" -i "$D/ipad/%05d.png" \
  -framerate "$FPS" -i "$D/ops/%05d.png" \
  -filter_complex "\
    [0:v]pad=1600:1200:0:150:color=#060605[tv]; \
    [1:v]pad=800:1200:0:26:color=#060605[ipad]; \
    [tv][ipad]hstack=inputs=2[room]; \
    [2:v]scale=-1:1200:flags=lanczos,pad=2400:1200:(ow-iw)/2:0:color=#0B0B0A[ops]; \
    [room][ops]overlay=0:0:enable='${ENABLE}'[v]" \
  -map "[v]" -c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p -movflags +faststart \
  -r "$FPS" "$OUTFILE"

echo "  wrote $OUTFILE"

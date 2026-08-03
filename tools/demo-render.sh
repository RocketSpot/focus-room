#!/bin/zsh
# ============================================================
# demo-render.sh, assemble the captured frames into the film.
# ------------------------------------------------------------
# Layout matches the 22 July reference: 1920x1080, the TV filling roughly two
# thirds on the left, the iPad on the right, cutting full-frame to the operator
# console during the windows the capture recorded.
#
# The frame rate comes from edit.json and is the rate the capture ACTUALLY
# achieved, not the one it asked for, so a four minute session plays back as
# four minutes rather than two and a half times too fast.
#
# Audio is reconstructed from the room's own beds rather than captured: the
# generative Web Audio layer cannot be rendered offline, but the two looping
# beds carry the scene and the interruption duck is reproduced at the moment
# the notification fired.
#
#   tools/demo-render.sh [out.mp4]
# ============================================================
set -e
ROOT="/Users/neurotech/focus-room"
D="$ROOT/data/demo"
OUTFILE="${1:-$D/focus-room-demo.mp4}"

FPS=$(python3 -c "import json;print(json.load(open('$D/edit.json'))['fps'])")
FRAMES=$(python3 -c "import json;print(json.load(open('$D/edit.json'))['frames'])")
DUR=$(python3 -c "print(f'{$FRAMES/$FPS:.2f}')")

runs_py() {
python3 - "$D/edit.json" "$FPS" "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); fps = float(sys.argv[2]); what = sys.argv[3]
cuts = sorted(d["cuts"]); runs = []; start = prev = None
for f in cuts:
    if start is None: start = prev = f; continue
    if f == prev + 1: prev = f; continue
    runs.append((start, prev)); start = prev = f
if start is not None: runs.append((start, prev))
if what == "enable":
    print("+".join(f"between(t,{a/fps:.3f},{(b+1)/fps:.3f})" for a, b in runs) or "0")
else:
    # the capture puts the second cutaway at 72% of a 100 s reading, so the bed
    # can change at the right moment without the capture logging beat times
    rs = (runs[1][0] / fps - 72.0) if len(runs) >= 2 else 60.0
    rs = max(4.0, rs)
    print(f"{rs:.2f} {max(6.0, rs + 20.0):.2f}")
PY
}
ENABLE=$(runs_py enable)
read -r LOBBY_END DUCK_AT <<< "$(runs_py audio)"
DUCK_END=$(python3 -c "print(f'{$DUCK_AT+3.2:.2f}')")
LOB_OUT=$(python3 -c "print(f'{max(1.0,$LOBBY_END-2):.2f}')")
FADE_OUT=$(python3 -c "print(f'{$DUR-3:.2f}')")

echo "  fps=$FPS  frames=$FRAMES  duration=${DUR}s"
echo "  session bed from ${LOBBY_END}s, interruption duck at ${DUCK_AT}s"
echo "  ops cutaways: $ENABLE"

ffmpeg -y -loglevel error -stats \
  -framerate "$FPS" -i "$D/tv/%05d.jpg" \
  -framerate "$FPS" -i "$D/ipad/%05d.jpg" \
  -framerate "$FPS" -i "$D/ops/%05d.jpg" \
  -stream_loop -1 -i "$ROOT/assets/audio/lobby.ogg" \
  -stream_loop -1 -i "$ROOT/assets/audio/session.ogg" \
  -filter_complex "\
[0:v]pad=1280:1080:0:180:color=#060605[tv];\
[1:v]scale=640:1080[ipad];\
[tv][ipad]hstack=inputs=2[room];\
[2:v]scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#0B0B0A[ops];\
[room][ops]overlay=0:0:enable='${ENABLE}'[v];\
[3:a]volume=0.50,afade=t=out:st=${LOB_OUT}:d=3,atrim=0:${DUR},asetpts=N/SR/TB[lob];\
[4:a]volume=0.60,afade=t=in:st=${LOBBY_END}:d=3,volume=0.28:enable='between(t,${DUCK_AT},${DUCK_END})',atrim=0:${DUR},asetpts=N/SR/TB[ses];\
[lob][ses]amix=inputs=2:duration=shortest:normalize=0,afade=t=out:st=${FADE_OUT}:d=3[a]" \
  -map "[v]" -map "[a]" \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 160k -movflags +faststart \
  -r "$FPS" "$OUTFILE"

echo "  wrote $OUTFILE"

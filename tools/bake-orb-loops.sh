#!/bin/zsh
# ============================================================
# bake-orb-loops.sh, make the orb clips actually loop.
# ------------------------------------------------------------
# The source renders are not loop-authored. Measured first frame against last
# frame, versus an ordinary one-frame step:
#
#   gold       28.19 dB seam vs 52.66 dB step   (-24.5 dB)
#   locked-in  27.63 dB seam vs 50.83 dB step   (-23.2 dB)
#   red        26.92 dB seam vs 37.71 dB step   (-10.8 dB)
#
# The seam carries five to eighteen times the error of a normal frame step, and
# per-frame brightness is flat throughout, so it is a motion discontinuity: the
# swirl is simply somewhere else at the end than at the start. No crossfade in
# the page can hide that, which is why three attempts at fixing this in CSS did
# not work. It has to be fixed in the asset.
#
# The fix: fold the tail back over the head INSIDE the video.
#
#   output(t) = clip(t + T)                      for t in [0, L-T)
#             = crossfade(clip(t+T) -> clip(t+T-L))  for t in [L-T, L)
#
# with L = D - T. The output therefore starts on clip(T) and ends on clip(T),
# so the loop point is an exact frame match by construction, and the one seam
# that remains is a slow dissolve in the middle of the clip between two states
# of the same swirl, which reads as the orb evolving.
#
# Once the asset loops, the page can use a plain <video loop> and the entire
# two-copy crossfade machinery goes away, along with the 25% compositing hole
# it opened on every single loop.
#
#   tools/bake-orb-loops.sh            rebuild every clip
# ============================================================
set -e
ROOT="/Users/neurotech/focus-room"
SRC="$ROOT/assets/orb"
WORK="${TMPDIR:-/tmp}/orb-bake"
XFADE=1.2                     # seconds of fold, 30 frames at 25 fps
TARGET_W=1728
TARGET_H=1080

mkdir -p "$WORK"

for f in "$SRC"/*.mp4; do
  name=$(basename "$f" .mp4)
  D=$(ffprobe -v error -select_streams v:0 -show_entries format=duration -of csv=p=0 "$f")
  W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$f")
  H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$f")
  L=$(python3 -c "print(f'{$D - $XFADE:.4f}')")
  OFF=$(python3 -c "print(f'{$D - 2*$XFADE:.4f}')")

  # every clip ends up the same size, so a state change does not also change
  # apparent sharpness: gold ships at 1152x720 while the other four are 1728x1080,
  # and object-fit: cover scales them by different factors on the same TV
  scale=""
  if [[ "$W" != "$TARGET_W" || "$H" != "$TARGET_H" ]]; then
    scale="scale=${TARGET_W}:${TARGET_H}:flags=lanczos,"
    echo "  $name: ${W}x${H} -> ${TARGET_W}x${TARGET_H}"
  fi

  echo "  $name: ${D}s -> ${L}s, folding ${XFADE}s tail over the head"
  ffmpeg -y -loglevel error -i "$f" -filter_complex "\
    [0:v]${scale}split=2[a][b]; \
    [a]trim=start=${XFADE},setpts=PTS-STARTPTS[main]; \
    [b]trim=end=${XFADE},setpts=PTS-STARTPTS[head]; \
    [main][head]xfade=transition=fade:duration=${XFADE}:offset=${OFF},format=yuv420p[v]" \
    -map "[v]" -an \
    -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p \
    -g 25 -keyint_min 25 \
    -movflags +faststart \
    "$WORK/$name.mp4"
done

# faststart matters as much as the loop: every one of these shipped with `moov`
# at the end of the file, which forces Chromium into streaming mode where it
# cannot know the duration until the whole file has arrived.
for f in "$WORK"/*.mp4; do
  mv "$f" "$SRC/$(basename "$f")"
done

echo
echo "  rebuilt:"
for f in "$SRC"/*.mp4; do
  printf "    %-14s %s  %sx%s  moov@%s\n" "$(basename "$f")" \
    "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" | cut -c1-5)s" \
    "$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$f")" \
    "$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$f")" \
    "$(python3 -c "
import sys,struct
d=open('$f','rb').read(); i=0
while i < len(d):
    n=struct.unpack('>I', d[i:i+4])[0]; t=d[i+4:i+8]
    if t==b'moov': print('front' if i < len(d)//2 else 'END'); break
    if n<8: break
    i+=n
")"
done

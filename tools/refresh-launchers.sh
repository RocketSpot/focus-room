#!/bin/zsh
# ============================================================
# refresh-launchers.sh, keep both .app launchers current
# ------------------------------------------------------------
# Both launchers run the LIVE repo, so application code is current the moment it
# is saved. Two things do NOT update themselves:
#
#   1. ipad/dist/app.js, the SERVED iPad bundle. The .jsx sources are built by
#      esbuild, so an edit to a screen changes nothing in the room until this runs.
#      This is the one that actually bites.
#   2. the launcher icons, if the orb art in build/resources/icon.png changes.
#
# Run by the git post-commit hook, so every commit leaves both launchers correct.
# Safe to run by hand at any time. Never touches the signed Desktop bundle's
# executable or signature (that bundle owns the Bluetooth permission grant).
# ============================================================
set -e
ROOM="/Users/neurotech/focus-room"
DESKTOP_APP="$HOME/Desktop/The Focus Room.app"
TEST_APP="$HOME/Documents/Focus Room (Test).app"
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$ROOM"

# 1. the served iPad bundle
npm run build:ipad >/dev/null 2>&1 && echo "  iPad bundle rebuilt" || echo "  iPad bundle FAILED"

# 2. icons, only if the source art is newer than what a launcher carries
SRC="$ROOM/build/resources/icon.png"
sync_icon() {
  app="$1"; icns="$app/Contents/Resources/icon.icns"
  [ -d "$app" ] || return 0
  [ -f "$SRC" ] || return 0
  [ -f "$icns" ] && [ "$icns" -nt "$SRC" ] && return 0   # already current
  tmp="$(mktemp -d)"; iset="$tmp/orb.iconset"; mkdir -p "$iset"
  for s in "16:16x16" "32:16x16@2x" "32:32x32" "64:32x32@2x" "128:128x128" \
           "256:128x128@2x" "256:256x256" "512:256x256@2x" "512:512x512" "1024:512x512@2x"; do
    sips -z "${s%%:*}" "${s%%:*}" "$SRC" --out "$iset/icon_${s##*:}.png" >/dev/null 2>&1
  done
  iconutil -c icns "$iset" -o "$icns" 2>/dev/null && echo "  icon refreshed: $(basename "$app")"
  rm -rf "$tmp"
  touch "$app"
}
sync_icon "$TEST_APP"
# The Desktop bundle is ad-hoc signed and holds the Bluetooth TCC grant; rewriting
# its icon invalidates the signature and macOS may re-prompt for Bluetooth. Only
# refresh it when explicitly asked.
[ "$1" = "--desktop-icon" ] && sync_icon "$DESKTOP_APP"

echo "  launchers current"

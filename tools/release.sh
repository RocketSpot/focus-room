#!/bin/zsh
# ============================================================
# release.sh, propagate an update to EVERY version of the app.
# ------------------------------------------------------------
# The two launchers on this Mac run the live repo and are current the moment a
# commit lands (the post-commit hook rebuilds the served iPad bundle). What
# does NOT update itself is everything downstream: the three portable zips,
# their GitHub release, the version feed that makes older portables show
# their "this version is outdated" dialog, and the copies in the Desktop's
# Focus Room Portables folder. This script does all of that, in order, and is
# safe to run at any time.
#
# It is normally invoked BY THE POST-COMMIT HOOK through a trailing-edge
# debounce: five minutes after the last app-affecting commit, one release runs
# for the whole burst. Run it by hand for an immediate cut.
#
#   tools/release.sh            full release (bump, build, upload, feed, desktop)
# ============================================================
set -e
ROOT="/Users/neurotech/focus-room"
LOCK="$ROOT/data/.release-lock"
LOG="$ROOT/data/release.log"
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$ROOT"

say() { echo "$(date -u +%H:%M:%SZ) $1" | tee -a "$LOG"; }

# one release at a time, atomically
if ! mkdir "$LOCK" 2>/dev/null; then
  say "release already running, skipping (rm -rf $LOCK if it is stale)"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# the tree must be clean and pushed: a release describes a commit, not a moment
# data/ is the room's writable state (logs the Test app appends on every
# launch, session records, demo frames): it can never be a reason not to ship
if [ -n "$(git status --porcelain -- ':!data')" ]; then
  say "working tree has uncommitted changes, refusing to release"
  exit 1
fi

# ---- 1. bump the patch version, commit with the marker the hook ignores ----
OLD=$(node -p "require('./package.json').version")
node -e "
const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8'));
const v=p.version.split('.').map(Number); v[2]+=1; p.version=v.join('.');
fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');
console.log(p.version);" > /tmp/newver
VERSION=$(cat /tmp/newver)
say "releasing v$VERSION (was $OLD, commit $(git rev-parse --short HEAD))"
git add package.json
git commit -q -m "[portables] v$VERSION

Automated portable release: version bump only. The [portables] marker keeps
the post-commit hook from scheduling a release for the release's own commit."
git push -q origin HEAD

# ---- 2. build all three portables ----
say "building portables..."
tools/build-portables.sh >> "$LOG" 2>&1
for z in dist/portable/focus-room-portable-*-v$VERSION.zip; do
  [ -f "$z" ] || { say "MISSING $z, aborting"; exit 1; }
done
say "built: $(ls dist/portable | tr '\n' ' ')"

# ---- 3. the GitHub release ----
say "uploading release v$VERSION..."
gh release create "v$VERSION" \
  --repo RocketSpot/focus-room --latest \
  --title "The Focus Room v$VERSION, portable" \
  --notes "Automated portable release from commit $(git rev-parse --short HEAD~1). Zero-setup: unzip and run; own Python runtime included. Older portables show their update dialog pointing here." \
  dist/portable/focus-room-portable-mac-apple-silicon-v$VERSION.zip \
  dist/portable/focus-room-portable-mac-intel-v$VERSION.zip \
  dist/portable/focus-room-portable-windows-v$VERSION.zip >> "$LOG" 2>&1

# ---- 4. the version feed: every older portable now shows its dialog ----
cat > /tmp/focus-room-version.json <<JSON
{
  "version": "$VERSION",
  "commit": "$(git rev-parse --short HEAD)",
  "url": "https://github.com/RocketSpot/focus-room/releases/latest",
  "note": "Zone, The Focus Room. This file only says which portable build is current."
}
JSON
gh gist edit 9cf29c209321123e8bc0c305404a46b5 -f focus-room-version.json /tmp/focus-room-version.json >> "$LOG" 2>&1
say "version feed -> $VERSION"

# ---- 5. the Desktop copies ----
DEST="$HOME/Desktop/Focus Room Portables"
mkdir -p "$DEST"
rm -f "$DEST"/focus-room-portable-*.zip
cp dist/portable/focus-room-portable-*-v$VERSION.zip "$DEST/"
say "desktop copies refreshed"

# ---- 6. a trailing commit queued during the build? go again, once ----
if [ -f "$ROOT/data/.release-pending" ]; then
  rm -f "$ROOT/data/.release-pending"
  say "commits landed during the build, running one trailing release"
  rmdir "$LOCK" 2>/dev/null
  trap - EXIT
  exec "$ROOT/tools/release.sh"
fi
say "release v$VERSION complete"

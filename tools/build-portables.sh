#!/bin/zsh
# ============================================================
# build-portables.sh, three self-contained zero-setup builds from one Mac.
# ------------------------------------------------------------
# Each portable is the COMPLETE room: the Electron app, every served surface,
# the sidecar source, and its own Python runtime with numpy, scipy and bleak
# already in site-packages. Unzip, open, done. Real earbuds work when they are
# near; simulation works everywhere; nothing is installed on the machine.
#
# HOW THE PYTHON TRAVELS. PyInstaller cannot cross-compile, so each portable
# instead carries a python-build-standalone interpreter for its platform with
# the wheels unpacked into site-packages. A wheel is a zip of the installed
# layout, so "install" is an unpack, the one operation that works for every
# target from a single build machine. The per-platform BLE backends (pyobjc on
# mac, winrt on windows) are listed EXPLICITLY because pip evaluates
# environment markers against the machine running pip, not the target, and
# would silently skip exactly the packages that make real earbuds work.
#
#   tools/build-portables.sh            build all three
# ============================================================
set -e
ROOT="/Users/neurotech/focus-room"
CACHE="$ROOT/build/pyruntime-cache"
STAGE="$ROOT/build/pyruntime/stage"
OUTDIR="$ROOT/dist/portable"
PYVER="3.12"
PBS_TAG="20250918"
PBS_PY="3.12.11"
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$ROOT"

VERSION=$(node -p "require('./package.json').version")
COMMIT=$(git rev-parse --short HEAD)
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "== portables v$VERSION ($COMMIT) =="

# ---- 0. the app's own build steps ------------------------------------------
node -e "require('fs').writeFileSync('app/version.json', JSON.stringify({
  version: '$VERSION', commit: '$COMMIT', builtAt: '$STAMP' }, null, 2) + '\n')"
npm run build:ipad >/dev/null 2>&1
npm run build:webroot >/dev/null 2>&1
echo "  version stamped, ipad bundle + webroot staged"

# ---- helpers ----------------------------------------------------------------
fetch_runtime() {  # $1 = pbs triple
  local triple=$1
  local tar="$CACHE/cpython-$PBS_PY-$triple.tar.gz"
  mkdir -p "$CACHE"
  if [ ! -f "$tar" ]; then
    echo "  fetching python runtime for $triple ..."
    curl -fsSL -o "$tar" \
      "https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_TAG/cpython-$PBS_PY+$PBS_TAG-$triple-install_only_stripped.tar.gz"
  fi
  rm -rf "$STAGE"; mkdir -p "$STAGE"
  tar -xzf "$tar" -C "$STAGE"                    # yields $STAGE/python
}

fetch_wheels() {  # $1 = comma-separated pip platforms, $2 = dest, then packages
  # Several tags per target, because projects tag their mac wheels at different
  # deployment floors: numpy at 10_9/11_0, scipy at 10_13 and, on arm, 12_0.
  # pip accepts repeated --platform and picks whichever tag a project shipped.
  local plats=$1 dir=$2; shift 2
  if [ -d "$dir" ] && [ -n "$(ls "$dir" 2>/dev/null)" ]; then return; fi
  mkdir -p "$dir"
  local args=()
  for t in ${(s:,:)plats}; do args+=(--platform "$t"); done
  # --no-deps, always. pip evaluates dependency markers against the machine
  # RUNNING it, so resolving bleak for a Windows target on a Mac demands mac
  # packages that have no Windows wheels and the whole resolution collapses.
  # Every dependency is therefore listed explicitly, and verified below.
  "$ROOT/venv/bin/pip" download -q --no-deps --only-binary=:all: "${args[@]}" \
    --python-version "$PYVER" --implementation cp -d "$dir" "$@"
  # every load-bearing package must actually be there, or fail NOW, loudly
  for must in numpy scipy bleak; do
    ls "$dir"/${must}-*.whl >/dev/null 2>&1 || { echo "MISSING WHEEL: $must in $dir"; exit 1; }
  done
}

unpack_wheels() {  # $1 = wheel dir, $2 = site-packages
  local dir=$1 sp=$2
  mkdir -p "$sp"
  for w in "$dir"/*.whl(N); do python3 -m zipfile -e "$w" "$sp/"; done
  for d in "$sp"/*.data(N); do
    [ -d "$d" ] || continue
    for sub in purelib platlib; do [ -d "$d/$sub" ] && cp -R "$d/$sub/." "$sp/"; done
    rm -rf "$d"
  done
}

COMMON=(numpy scipy bleak)
MAC_EXTRA=(pyobjc-core pyobjc-framework-CoreBluetooth pyobjc-framework-libdispatch pyobjc-framework-Cocoa)
WIN_EXTRA=(winrt-runtime "winrt-Windows.Devices.Bluetooth" "winrt-Windows.Devices.Bluetooth.Advertisement"
  "winrt-Windows.Devices.Bluetooth.GenericAttributeProfile" "winrt-Windows.Devices.Enumeration"
  "winrt-Windows.Devices.Radios" "winrt-Windows.Foundation" "winrt-Windows.Foundation.Collections"
  "winrt-Windows.Storage.Streams")

readme() {  # $1 = platform blurb file
  cat > "$1" <<TXT
Zone, The Focus Room  (portable v$VERSION, build $COMMIT)

RUN IT
  macOS:   unzip, then RIGHT-CLICK "Zone Focus Room.app" and choose Open the
           first time (it is signed but not notarized, so double-click alone
           is refused once by Gatekeeper). After that, double-click works.
  Windows: unzip, open the folder, run "Zone Focus Room.exe". If SmartScreen
           objects, choose More info, then Run anyway.

WHAT IS INSIDE
  The complete room: TV surfaces, iPad flow (open
  http://<this-machine>:4321/ipad-flow.html on the iPad), operator console at
  http://localhost:4321/ops.html, the signal engine with its own Python
  runtime, numpy, scipy and bleak already in place. Nothing to install.

REAL EARBUDS OR SIMULATION
  Launched plainly it runs REAL mode and looks for Zone earbuds over
  Bluetooth. For a demo without buds, launch with FOCUSROOM_SIMULATE=1
  (mac: FOCUSROOM_SIMULATE=1 open "Zone Focus Room.app") and every screen
  carries a SIMULATED badge, honestly.

UPDATES
  The app checks a tiny version feed at launch. When a newer portable exists
  it shows one dialog pointing at the download page, and never nags twice in
  a run. Offline, it stays silent.
TXT
}

mkdir -p "$OUTDIR"
# superseded zips leave: each release replaces the set wholesale, and letting
# old versions accumulate here made every later glob ambiguous
rm -f "$OUTDIR"/focus-room-portable-*.zip

# ---- mac arm64 --------------------------------------------------------------
echo "-- mac arm64 --"
fetch_runtime "aarch64-apple-darwin"
fetch_wheels "macosx_11_0_arm64,macosx_12_0_arm64,macosx_13_0_arm64,macosx_14_0_arm64" "$CACHE/wheels-mac-arm64" "${COMMON[@]}" "${MAC_EXTRA[@]}"
unpack_wheels "$CACHE/wheels-mac-arm64" "$STAGE/python/lib/python$PYVER/site-packages"
npx electron-builder --mac zip --arm64 2>&1 | grep -E "building|packaging|signing" | sed 's/^/    /' || true
mv "$ROOT"/dist/*-arm64-mac.zip "$OUTDIR/focus-room-portable-mac-apple-silicon-v$VERSION.zip" 2>/dev/null \
  || mv "$ROOT"/dist/*arm64*.zip "$OUTDIR/focus-room-portable-mac-apple-silicon-v$VERSION.zip"

# ---- mac x64 (Intel) --------------------------------------------------------
echo "-- mac x64 --"
fetch_runtime "x86_64-apple-darwin"
fetch_wheels "macosx_10_9_x86_64,macosx_10_13_x86_64,macosx_12_0_x86_64,macosx_13_0_x86_64,macosx_14_0_x86_64" "$CACHE/wheels-mac-x64" "${COMMON[@]}" "${MAC_EXTRA[@]}"
unpack_wheels "$CACHE/wheels-mac-x64" "$STAGE/python/lib/python$PYVER/site-packages"
npx electron-builder --mac zip --x64 2>&1 | grep -E "building|packaging|signing" | sed 's/^/    /' || true
mv "$ROOT"/dist/*-mac.zip "$OUTDIR/focus-room-portable-mac-intel-v$VERSION.zip"

# ---- windows x64 ------------------------------------------------------------
echo "-- windows x64 --"
fetch_runtime "x86_64-pc-windows-msvc"
fetch_wheels "win_amd64" "$CACHE/wheels-win-x64" "${COMMON[@]}" "${WIN_EXTRA[@]}"
unpack_wheels "$CACHE/wheels-win-x64" "$STAGE/python/Lib/site-packages"
npx electron-builder --win zip --x64 2>&1 | grep -E "building|packaging" | sed 's/^/    /' || true
# electron-builder sometimes stops at the unpacked dir for cross-built windows
# zips; the zip target is only an archive of that dir anyway, so make it
# ourselves, deterministically, with the app folder named at the top level.
if ! ls "$ROOT"/dist/*-win.zip >/dev/null 2>&1; then
  (cd "$ROOT/dist" && rm -rf "Zone Focus Room" && cp -R win-unpacked "Zone Focus Room" \
    && zip -qry "focus-room-win.zip" "Zone Focus Room" && rm -rf "Zone Focus Room")
fi
mv "$ROOT"/dist/*win*.zip "$OUTDIR/focus-room-portable-windows-v$VERSION.zip"

# ---- READMEs into each zip --------------------------------------------------
readme /tmp/README.txt
for z in "$OUTDIR"/focus-room-portable-*-v$VERSION.zip(N); do
  (cd /tmp && zip -q "$z" README.txt)
done

rm -rf "$STAGE"
echo
echo "== done =="
ls -lh "$OUTDIR" | awk 'NR>1 {print "  "$9"  "$5}'

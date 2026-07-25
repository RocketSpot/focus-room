# The Focus Room — Build & Run

## Prerequisites

- **Node** ≥ 20 and **npm** (developed on Node 24, npm 11).
- **Python 3.12** virtualenv at `venv/` with the Zone SDK already installed
  (`bleak`, `numpy`, `scipy`, `zone_sdk`). Do **not** reinstall the SDK.
- PyInstaller in the venv for freezing the sidecar — Windows:
  `venv\Scripts\python -m pip install pyinstaller`; macOS: `venv/bin/python -m pip install pyinstaller`.

## BLE connect — catalogue-free (GATT probe)

The sidecar connects to any genuine Zone bud **without** the UUID catalogue.
`connect()` installs two hooks on the SDK (`_install_overrides`) and then runs
the SDK's **normal validated** `connect_selected`: the profile loader returns a
single synthetic "auto" pair, and the pair matcher (`_match_side` → `_probe_uuids`)
opens the bud's GATT *inside the SDK's own connect sequence* and picks the EEG
service — ranked: Zone `00000000-2fda-…` family with separate notify+write chars
first, then any disjoint notify/write vendor service, skipping SIG-standard and
DFU services (Nordic UART accepted if a bud ever uses it). Because it stays on
the validated path, the active pair and profile name are set normally, so the
impedance fit check and the SDK's internal auto-reconnect both work. See
`sidecar/zone_source.py`. Every probe logs a full GATT dump to the diagnostic;
if a session streams but no EEG frames arrive in 6s, it reports `no_eeg_data`
(the probed service likely wasn't the EEG one — read the dump).

`ble_profiles.json` (and `build/gen-ble-profiles.py`, which generates it from the
UUID & Device Tracking Catalogue) are now a **legacy fallback only** — the connect
path no longer reads them.

## Run in development

```bash
npm install
npm run dev          # Electron + sidecar in SIMULATION (no buds needed)
npm run dev:real     # same, but the real Zone SDK source (buds required)
```

`npm run dev` launches Electron, which spawns `sidecar/main.py` with the venv
interpreter and supervises it. The TV window shows the live line; press
**Ctrl+Shift+D** for the diagnostic overlay. The iPad URL is printed in the
console (`http://<lan-ip>:4321/ipad-flow.html`).

Standalone sidecar check (no Electron):

```bash
venv\Scripts\python sidecar\main.py --selftest --simulate --seconds 60
```

## Build the Windows installer (.exe) — ACTIVE TARGET

```bash
npm run dist:win
```

This runs, in order:
1. `build:sidecar:win` → PyInstaller freezes the sidecar to
   `build/sidecar/win32/zone-sidecar/` and smoke-tests it.
2. `prepare:win` → one-time per-machine winCodeSign cache seed (see below).
3. `build:webroot` → stages the served surfaces into `build/webroot`.
4. `electron-builder --win --x64` → produces `dist/Zone Focus Room Setup <ver>.exe`
   (NSIS). The frozen sidecar and webroot ship as `resources/sidecar` and
   `resources/webroot`.

### winCodeSign symlink prerequisite (Windows)

electron-builder downloads `winCodeSign-2.6.0.7z` (it bundles `signtool.exe`)
during packaging. That archive contains two **macOS** symlinks
(`darwin/.../libcrypto.dylib`, `libssl.dylib`). Extracting a symlink on Windows
requires `SeCreateSymbolicLinkPrivilege`, which is off for a standard
(non-elevated, Developer-Mode-off) account — so the extraction aborts and the
NSIS build fails, even though those symlinks are irrelevant to a Windows build.

`npm run prepare:win` (folded into `build:win`) pre-seeds electron-builder's
cache with the archive extracted **without** the two mac symlinks, so packaging
finds a ready cache and never tries to create them. It's a one-time, per-machine
step. Alternatively, enable **Windows Developer Mode** (Settings → For
developers) or run the build from an **elevated** terminal, and the standard
extraction succeeds on its own.

## Build the macOS .dmg — DEFERRED (do this on the Mac Mini)

PyInstaller **cannot cross-compile**, so the macOS sidecar must be frozen on a
Mac: `pyinstaller sidecar/zone-sidecar.spec` → `build/sidecar/darwin/zone-sidecar/`.
Then `electron-builder --mac`. macOS additionally requires, and the config in
`electron-builder.yml` already declares the hooks for:

- `NSBluetoothAlwaysUsageDescription` (set via `mac.extendInfo`).
- A **signed + notarized** build so the spawned sidecar can use Bluetooth
  without Gatekeeper friction. Set `CSC_LINK`/`CSC_KEY_PASSWORD` (Developer ID
  Application cert) and notarization creds (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`) in the environment. Entitlements: `build/resources/entitlements.mac.plist`.

**Warning:** a macOS build without signing **and** notarization will fail
Gatekeeper when the spawned sidecar reaches for Bluetooth — the entitlement
alone is not enough on a hardened-runtime, unsigned binary. Do not ship an
unsigned macOS build; BLE will silently fail.

The two builds must behave identically. Only the sidecar freeze and the
signing/entitlements differ per OS.

## Secrets

The Postmark API key (email send) is read from the environment / local config
(`POSTMARK_API_KEY`), never hard-coded and never committed. See `.env` (gitignored).

## Fonts

All fonts are bundled and served locally (no CDN). Drop the licensed/OFL files
into `assets/fonts/files/` per `assets/fonts/README.md`.

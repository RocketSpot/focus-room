# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Zone Focus Room sidecar (onedir).
# Build (Windows):  npm run build:sidecar:win   (see build/build-sidecar.ps1)
# Build (macOS):    pyinstaller sidecar/zone-sidecar.spec  (on the Mac Mini)
# PyInstaller CANNOT cross-compile — each OS freezes its own binary.
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

HERE = SPECPATH  # the sidecar/ directory (injected by PyInstaller)

datas = []
binaries = []
hiddenimports = []

# Bundle the Zone SDK and Bleak (incl. its OS BLE backend) fully. numpy/scipy
# are handled by PyInstaller's built-in hooks; we add the signal submodule the
# SDK's processors rely on.
for pkg in ("zone_sdk", "bleak"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

hiddenimports += ["scipy.signal", "scipy.special", "scipy.fft", "scipy.integrate"]
hiddenimports += collect_submodules("bleak.backends")

# ship the generated BLE profile inside the SDK package so connect_selected can
# profile-validate the buds in the frozen build (the SDK reads it as a zone_sdk
# package resource). Generated from the engineering UUID catalogues by
# build/gen-ble-profiles.py; the three technique variants ride along next
# to the sidecar so FOCUSROOM_UUID_CATALOGUE=1|2|3 works in the frozen build too.
_profiles = os.path.join(HERE, "ble_profiles.json")
if os.path.exists(_profiles):
    datas += [(_profiles, "zone_sdk")]
for _n in (1, 2, 3):
    _cat = os.path.join(HERE, f"ble_profiles.catalogue-{_n}.json")
    if os.path.exists(_cat):
        datas += [(_cat, ".")]

a = Analysis(
    [os.path.join(HERE, "main.py")],
    pathex=[HERE],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "PyQt5", "PyQt6", "PySide2", "PySide6", "PIL", "IPython"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="zone-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,            # console subprocess; spawned with windowsHide → no window
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="zone-sidecar",
)

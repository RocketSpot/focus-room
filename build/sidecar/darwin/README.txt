The frozen macOS sidecar lands here (built ON a Mac: PyInstaller cannot
cross-compile — see docs/BUILD.md). This placeholder keeps electron-builder's
extraResources staging happy for mac builds made before that step; the
packaged app then falls back to resources/sidecar-src on python3.

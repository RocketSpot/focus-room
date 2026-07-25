# ============================================================
# prepare-wincodesign.ps1 - one-time, per-machine build prerequisite.
# ------------------------------------------------------------
# electron-builder downloads winCodeSign-2.6.0.7z (it bundles signtool.exe)
# for the Windows packaging step. That archive contains two macOS symlinks
# (darwin libcrypto/libssl .dylib). Extracting a symlink on Windows needs
# SeCreateSymbolicLinkPrivilege (Developer Mode ON, or an elevated shell);
# without it the extraction aborts and the NSIS build fails - even though the
# symlinks are irrelevant to a Windows build.
#
# This pre-seeds electron-builder's cache with the archive extracted WITHOUT
# the two mac symlinks, so the packaging step finds a ready cache and never
# tries to extract them. Run once per machine before `npm run build:win`.
#
# Alternative one-time fix: enable Windows Developer Mode (Settings -> For
# developers), or run the build from an elevated terminal.
# ============================================================
$ErrorActionPreference = "Stop"
$root  = Split-Path $PSScriptRoot -Parent
$cache = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\winCodeSign"
$final = Join-Path $cache "winCodeSign-2.6.0"
$7z    = Join-Path $root "node_modules\7zip-bin\win\x64\7za.exe"
$url   = "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z"
$tmp   = Join-Path $env:TEMP "winCodeSign-2.6.0.7z"

if (Test-Path (Join-Path $final "windows-10\x64\signtool.exe")) {
  Write-Host "[prepare-wincodesign] cache already seeded -> $final"
  exit 0
}
if (-not (Test-Path $7z)) { throw "7za not found ($7z) - run npm install first" }
if (-not (Test-Path $tmp)) {
  Write-Host "[prepare-wincodesign] downloading winCodeSign..."
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tmp
}
New-Item -ItemType Directory -Force $final | Out-Null
# exit code 2 = the two mac symlinks failed; everything Windows needs is fine.
& $7z x $tmp "-o$final" -y | Out-Null
if (-not (Test-Path (Join-Path $final "windows-10\x64\signtool.exe"))) {
  throw "winCodeSign extraction incomplete - signtool.exe missing"
}
Write-Host "[prepare-wincodesign] OK -> $final"

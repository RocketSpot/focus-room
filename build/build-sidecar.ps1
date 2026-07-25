# ============================================================
# build-sidecar.ps1 - freeze the Python sidecar into a standalone
# onedir binary for Windows. PyInstaller cannot cross-compile, so this
# runs on Windows and produces build/sidecar/win32/zone-sidecar/.
# The macOS binary is built on the Mac Mini with the same .spec.
# ============================================================
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$py = Join-Path $root "venv\Scripts\python.exe"

if (-not (Test-Path $py)) { throw "venv python not found at $py" }

$dist = Join-Path $root "build\sidecar\win32"
$work = Join-Path $root "build\_pyinstaller"

Write-Host "[build-sidecar] freezing -> $dist"
& $py -m PyInstaller --noconfirm `
    --distpath $dist `
    --workpath $work `
    (Join-Path $root "sidecar\zone-sidecar.spec")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed ($LASTEXITCODE)" }

$exe = Join-Path $dist "zone-sidecar\zone-sidecar.exe"
if (-not (Test-Path $exe)) { throw "expected frozen binary missing: $exe" }

Write-Host "[build-sidecar] smoke-testing frozen binary (selftest, sim)..."
# Capture full output - do NOT pipe to Select-Object -First (that closes the
# pipe early and kills the child, producing a false-negative exit code).
# And do NOT let $ErrorActionPreference=Stop turn the sidecar's ordinary
# STDERR log lines (2>&1 wraps each as an ErrorRecord) into a fatal throw -
# that killed the build the moment the sidecar started logging on stderr.
$eap = $ErrorActionPreference; $ErrorActionPreference = "Continue"
$selftest = & $exe --selftest --simulate --seconds 3 2>&1 | ForEach-Object { "$_" }
$ErrorActionPreference = $eap
if ($LASTEXITCODE -ne 0) { $selftest; throw "frozen sidecar selftest failed ($LASTEXITCODE)" }
if (($selftest -join "`n") -notmatch '"type":"ready"') { $selftest; throw "frozen sidecar did not reach ready" }
Write-Host "[build-sidecar] OK -> $exe"

@echo off
REM ───────────────────────────────────────────────────────────────────────────
REM Builds LittlePad for WINDOWS (plain .exe, no .msi/NSIS installer)
REM NATIVELY. MUST run on Windows (cmd or PowerShell); does not use Docker.
REM
REM Usage:  scripts\build-windows.bat
REM Output: .\out\ — littlepad.exe (the app) and littlepad-relay-server.exe
REM         (the optional share relay server — see Settings -> Share; run it
REM         on whatever machine should host sharing, not necessarily here)
REM
REM Requirements (validated when run):
REM   - Rust (stable):    https://rustup.rs
REM   - Node.js >= 20:    https://nodejs.org
REM   - WebView2 Runtime (already installed on modern Windows 10/11)
REM   - MSVC linker (link.exe): does NOT ship with Rust or Node. If "cargo
REM     build"/"npm run tauri build" fails with "linker `link.exe` not found",
REM     install "Build Tools for Visual Studio" (NOT the full Visual Studio
REM     IDE — a separate installer with just the command-line compiler/
REM     linker) with the "Desktop development with C++" workload:
REM     https://visualstudio.microsoft.com/visual-cpp-build-tools/
REM
REM No installer is produced (--no-bundle): the output is the plain,
REM standalone .exe, ready to copy/run on any compatible Windows machine.
REM Not code-signed (requires a certificate + signtool separately).
REM ───────────────────────────────────────────────────────────────────────────
setlocal

REM Go to the project root (the parent folder of scripts\)
cd /d "%~dp0.."

where cargo >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Missing Rust. Install: https://rustup.rs
    exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Missing Node.js ^>= 20: https://nodejs.org
    exit /b 1
)

echo "-- [1/4] Installing npm dependencies --"
call npm install
if errorlevel 1 exit /b
call npm ci
if errorlevel 1 exit /b 1

echo "-- [2/4] Generating icons from app-icon.svg --"
call npm run tauri icon app-icon.svg
if errorlevel 1 exit /b 1

echo "-- [3/4] Building the app (executable only) --"
call npm run tauri build -- --no-bundle
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed.
    echo   If the error mentions "linker link.exe not found": you're missing
    echo   the MSVC linker. Install "Build Tools for Visual Studio" ^(NOT the
    echo   full Visual Studio IDE^) with the "Desktop development with C++"
    echo   workload: https://visualstudio.microsoft.com/visual-cpp-build-tools/
    exit /b 1
)

echo "-- [4/4] Building the share relay server --"
call cargo build --release -p relay-server
if errorlevel 1 exit /b 1

if not exist out mkdir out
REM "target\", not "src-tauri\target\" — src-tauri is a Cargo workspace
REM member (see the root Cargo.toml, added for relay-server\); Cargo always
REM builds workspace members into one shared target dir at the workspace root.
REM Source name is "LittlePad.exe" — Cargo.toml's package name, case as-is
REM (NTFS doesn't care, but this is the actual name cargo/tauri produce).
copy /y "target\release\LittlePad.exe" out\ >nul 2>nul
copy /y "target\release\littlepad-relay-server.exe" out\ >nul 2>nul

echo.
echo [OK] Windows build done - artifacts in .\out\
dir /b out
endlocal

@echo off
REM Launch Decoy in development (electron-vite: Vite dev server + Electron). Type `decoy`
REM here in cmd, or `.\decoy` in PowerShell. Runs from this script's folder regardless of cwd.
pushd "%~dp0"
call pnpm dev
popd

@echo off
REM Launch Decoy in development (starts Vite + Electron). Type `decoy` here in
REM cmd, or `.\decoy` in PowerShell. Runs from this script's folder regardless of cwd.
pushd "%~dp0"
call pnpm electron:dev
popd

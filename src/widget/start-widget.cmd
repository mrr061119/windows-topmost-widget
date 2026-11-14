@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo [topmost-widget] Electron not installed.
  echo Run in this folder:  npm install
  pause
  exit /b 1
)

start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
endlocal

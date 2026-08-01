@echo off
title Voodoo Miner — Local Server
cd /d "%~dp0"
echo.
echo  ========================================
echo   Voodoo Miner
echo   Folder: %~dp0
echo  ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo  ERROR: Node.js not found.
  echo  Install from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0index.html" (
  echo  ERROR: index.html not found here.
  echo  Expected: %~dp0index.html
  echo.
  pause
  exit /b 1
)

echo  Starting server...
echo  URL: http://127.0.0.1:8081/
echo  Keep this window OPEN while using the dapp.
echo  Press Ctrl+C to stop.
echo.
node "%~dp0server.js"
echo.
echo  Server stopped.
pause

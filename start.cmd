@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found in PATH. Install Node.js LTS and restart TouchPortal.
  exit /b 1
)
node "%~dp0src\index.js"

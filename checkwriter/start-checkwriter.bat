@echo off
cd /d "%~dp0"

if not exist "dist\index.cjs" (
  echo The app has not been built yet.
  echo Please run setup.bat first.
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo The .env configuration file is missing.
  echo Please run setup.bat first.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Components are missing.
  echo Please run setup.bat first.
  echo.
  pause
  exit /b 1
)

echo Starting CheckWriter...
echo.
echo A second window will open and must stay open while you work.
echo Closing that window shuts CheckWriter down.
echo.

start "CheckWriter server - keep this window open" cmd /k node dist\index.cjs

rem give the server a moment to bind the port before the browser opens
timeout /t 5 /nobreak >nul
start "" http://localhost:5000

echo Opened http://localhost:5000 in your browser.
echo.
echo If the page did not load, wait a few seconds and refresh it.
timeout /t 4 /nobreak >nul

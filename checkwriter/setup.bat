@echo off
setlocal
cd /d "%~dp0"

echo ==============================================
echo    CheckWriter - one-time setup
echo ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js is not installed.
  echo.
  echo     1. Go to https://nodejs.org
  echo     2. Download the "LTS" installer for Windows
  echo     3. Install it, then run this file again
  echo.
  if not defined CW_NOPAUSE pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEV=%%v
echo [ok] Node.js %NODEV% detected

node -e "if((process.versions.node.split('.')[0]|0)<20){process.exit(1)}"
if errorlevel 1 (
  echo [X] That version of Node.js is too old. CheckWriter needs Node.js 20
  echo     or newer. Install the current LTS release from https://nodejs.org
  echo     and run this file again.
  echo.
  if not defined CW_NOPAUSE pause
  exit /b 1
)

echo.
echo Installing components. The first run takes a few minutes.
echo.
call npm install
if errorlevel 1 (
  echo.
  echo [X] Component install failed - see the messages above.
  echo.
  echo     If you see "gyp", "MSBuild", "Visual Studio" or "python" in the
  echo     errors above, the database component tried to compile itself from
  echo     source instead of downloading a ready-made version for your
  echo     Node.js release.
  echo.
  echo     Two ways to fix it:
  echo       1. Install the current LTS from https://nodejs.org, delete the
  echo          node_modules folder, then run this file again. This is the
  echo          easy fix and works almost every time.
  echo       2. Or install the build tools:  npm install --global windows-build-tools
  echo.
  if not defined CW_NOPAUSE pause
  exit /b 1
)

node -e "try{require('better-sqlite3');console.log('[ok] Database component loaded')}catch(e){console.error('[X] The database component installed but will not load:');console.error('    '+e.message);process.exit(1)}"
if errorlevel 1 (
  echo.
  echo     This normally means the component was built for a different
  echo     version of Node.js than the one now installed. Delete the
  echo     node_modules folder and run this file again.
  echo.
  if not defined CW_NOPAUSE pause
  exit /b 1
)
echo.
echo [ok] Components installed

echo.
if exist ".env" (
  echo [ok] Keeping the existing .env file on this computer.
  echo      Your encryption key lives in there. Do not delete it.
) else (
  node -e "const c=require('crypto'),f=require('fs');f.writeFileSync('.env','SESSION_SECRET='+c.randomBytes(48).toString('base64url')+'\nENCRYPTION_KEY='+c.randomBytes(32).toString('hex')+'\nLOCAL_HTTP=1\nPORT=5000\n');"
  if errorlevel 1 (
    echo [X] Could not create the .env file.
    if not defined CW_NOPAUSE pause
    exit /b 1
  )
  echo [ok] Created .env with private keys generated on this computer.
)

echo.
echo Building the app...
call npm run build
if errorlevel 1 (
  echo.
  echo [X] Build failed - see the messages above.
  echo.
  if not defined CW_NOPAUSE pause
  exit /b 1
)

echo.
echo ==============================================
echo    Setup complete
echo ==============================================
echo.
echo   To open CheckWriter, run:  start-checkwriter.bat
echo.
echo   First launch shows a setup wizard - create your own
echo   administrator account and first business there.
echo.
echo   BACK UP THESE TWO FILES:
echo     .env      - holds your encryption key
echo     data.db   - holds your businesses, payees and checks
echo.
echo   Without .env, saved bank account numbers cannot be read back.
echo   Run backup.bat any time to copy both somewhere safe.
echo.
if not defined CW_NOPAUSE pause

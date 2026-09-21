@echo off
setlocal
cd /d "%~dp0"

echo ==============================================
echo    CheckWriter - backup
echo ==============================================
echo.

if not exist "data.db" (
  echo Nothing to back up yet - data.db does not exist.
  echo Start CheckWriter and create a check first.
  echo.
  pause
  exit /b 1
)

rem String.fromCharCode(45) is a hyphen - avoids single quotes, which do not
rem survive the for /f command block reliably
for /f "tokens=*" %%s in ('node -e "console.log(new Date().toISOString().slice(0,19).replace(/[:T]/g,String.fromCharCode(45)))"') do set STAMP=%%s
if "%STAMP%"=="" set STAMP=manual

set DEST=backups\%STAMP%
mkdir "%DEST%" 2>nul

copy /y "data.db" "%DEST%\" >nul
if exist "data.db-wal" copy /y "data.db-wal" "%DEST%\" >nul
if exist "data.db-shm" copy /y "data.db-shm" "%DEST%\" >nul
if exist ".env" copy /y ".env" "%DEST%\env-backup.txt" >nul

echo [ok] Backed up to:
echo      %CD%\%DEST%
echo.
echo      data.db          your checks, payees and businesses
echo      env-backup.txt   your encryption key - keep this private
echo.
echo Copy that folder to a USB drive or private cloud folder.
echo Anyone with env-backup.txt plus data.db can read your stored
echo bank account numbers, so keep the backup somewhere secure.
echo.
pause

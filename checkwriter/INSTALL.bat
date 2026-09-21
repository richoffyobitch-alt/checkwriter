@echo off
setlocal
cd /d "%~dp0"

echo ==================================================
echo    CheckWriter - install on this computer
echo ==================================================
echo.
echo This does everything in one go:
echo   1. checks Node.js is present
echo   2. installs components
echo   3. generates your private encryption keys
echo   4. builds the app
echo   5. puts a CheckWriter shortcut on your Desktop
echo.
pause

set CW_NOPAUSE=1
call "%~dp0setup.bat" 2>&1 | powershell -NoProfile -Command "$input | Tee-Object -FilePath '%~dp0install-log.txt'"
set CW_NOPAUSE=

if not exist "%~dp0dist\index.cjs" (
  echo.
  echo ==================================================
  echo    [X] Setup did not finish
  echo ==================================================
  echo.
  echo A full log was saved to:
  echo    %~dp0install-log.txt
  echo.
  echo Send that file back and it can be diagnosed exactly.
  echo Nothing else on this computer was changed.
  echo.
  pause
  exit /b 1
)

echo.
echo Creating the Desktop shortcut...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$lnk = $ws.CreateShortcut([System.IO.Path]::Combine($ws.SpecialFolders('Desktop'),'CheckWriter.lnk'));" ^
  "$lnk.TargetPath = '%~dp0start-checkwriter.bat';" ^
  "$lnk.WorkingDirectory = '%~dp0';" ^
  "$lnk.Description = 'Open CheckWriter';" ^
  "$lnk.Save()"

if errorlevel 1 (
  echo [!] Could not create the Desktop shortcut. Not a problem - you can
  echo     still open the app with start-checkwriter.bat in this folder.
) else (
  echo [ok] Shortcut created: CheckWriter on your Desktop
)

echo.
echo ==================================================
echo    Installed
echo ==================================================
echo.
echo Double-click CheckWriter on your Desktop to open it.
echo.
echo First launch shows a setup wizard. Create your own
echo administrator account and your first business there.
echo.
echo BACK UP THESE TWO FILES from this folder:
echo    .env      your encryption key
echo    data.db   your businesses, payees and checks
echo.
echo Without .env, saved bank account numbers cannot be read
echo back. Run backup.bat any time to copy both somewhere safe.
echo.
echo BEFORE YOU PRINT ON REAL CHECK STOCK:
echo    Open Printers and Calibration and run a test print.
echo    Take one printed sample to your bank and have them
echo    confirm the MICR line and layout scan correctly on
echo    their equipment before you issue any live check.
echo.

choice /C YN /M "Open CheckWriter now"
if errorlevel 2 goto :done
start "" "%~dp0start-checkwriter.bat"

:done
echo.
pause

@echo off
setlocal
set "RADTV_EXIT=1"
pushd "%~dp0"
if errorlevel 1 goto finish
set "RADTV_PUSHED=1"
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or later is required. Install it on the computer running this launcher.
  goto finish
)
echo [uburoom] Installing dependencies. Please wait for the final result.
call npm ci --ignore-scripts --no-audit --no-fund
set "RADTV_EXIT=%errorlevel%"
if "%RADTV_EXIT%"=="0" (
  echo [uburoom] Installation complete. Launch run-uburoom.bat on your server.
) else (
  echo [uburoom] Installation failed. Exit code: %RADTV_EXIT%. Read the npm error above.
)
:finish
if defined RADTV_PUSHED popd
pause
exit /b %RADTV_EXIT%

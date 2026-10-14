@echo off
setlocal
set "RADTV_EXIT=1"
rem pushd also supports a UNC share when launched from the development computer.
pushd "%~dp0"
if errorlevel 1 goto finish
set "RADTV_PUSHED=1"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or later is required. Install it on the computer running this launcher.
  goto finish
)
if not exist "node_modules\ws" goto missing_dependencies
if not exist "node_modules\discord.js" goto missing_dependencies
if not exist "node_modules\hls.js" goto missing_dependencies
echo [uburoom] Starting server. This window stays open if startup fails.
node --env-file-if-exists=.env server\index.js
set "RADTV_EXIT=%errorlevel%"
goto finish
:missing_dependencies
echo Dependencies are missing. Run install-uburoom.bat once first.
:finish
if defined RADTV_PUSHED popd
echo [uburoom] Server stopped. Exit code: %RADTV_EXIT%
pause
exit /b %RADTV_EXIT%

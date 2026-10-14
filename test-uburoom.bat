@echo off
setlocal
pushd "%~dp0" || exit /b 1
node --test tests\*.test.js
set "RADTV_EXIT=%errorlevel%"
popd
exit /b %RADTV_EXIT%

@echo off
setlocal
pushd "%~dp0" || exit /b 1
node --test tests\*.test.js
set "UBUROOM_EXIT=%errorlevel%"
popd
exit /b %UBUROOM_EXIT%

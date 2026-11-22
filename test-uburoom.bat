@echo off
setlocal
pushd "%~dp0" || exit /b 1
call npm test
set "UBUROOM_EXIT=%errorlevel%"
popd
exit /b %UBUROOM_EXIT%

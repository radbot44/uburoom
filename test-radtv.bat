@echo off
rem Legacy launcher path retained for existing installations.
call "%~dp0test-uburoom.bat" %*
exit /b %errorlevel%

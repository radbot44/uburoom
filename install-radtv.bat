@echo off
rem Legacy launcher path retained for existing installations.
call "%~dp0install-uburoom.bat" %*
exit /b %errorlevel%

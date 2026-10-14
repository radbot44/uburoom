@echo off
rem Legacy launcher path retained for existing installations.
call "%~dp0run-uburoom.bat" %*
exit /b %errorlevel%

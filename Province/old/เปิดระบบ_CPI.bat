@echo off
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py server.py
  goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
  python server.py
  goto :end
)

echo.
echo Python was not found on this computer.
echo Please install Python 3 and run this file again.
echo.
pause

:end

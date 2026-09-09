@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>&1
if %errorlevel%==0 (
  py server.py
  exit /b
)
where python >nul 2>&1
if %errorlevel%==0 (
  python server.py
  exit /b
)
echo.
echo ไม่พบ Python ในเครื่อง
 echo สามารถดับเบิลคลิก index.html ได้ แต่จะใช้ฐานข้อมูลที่ฝังไว้ในเว็บ
pause

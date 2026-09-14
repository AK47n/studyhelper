@echo off
chcp 65001 >nul
title studyhelper 过手总结台
cd /d "%~dp0"

if not exist "dist\index.html" (
  echo.
  echo   第一次运行，正在构建页面（只需要这一次，大约十几秒）...
  echo.
  call npx vite build
  if errorlevel 1 (
    echo.
    echo   构建失败。请确认已装 Node.js，然后在本目录执行：npm install
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   正在启动 studyhelper ...
echo.
node server.js
pause

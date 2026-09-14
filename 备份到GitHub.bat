@echo off
chcp 65001 >nul
title studyhelper 备份到 GitHub
cd /d "%~dp0"

echo.
echo   把 data\ 里新写的总结提交并推到 GitHub ...
echo.

node scripts\sync.js
pause

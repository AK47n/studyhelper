@echo off
chcp 65001 >nul
title studyhelper
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\toggle.ps1"

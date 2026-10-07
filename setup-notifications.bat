@echo off
title Bali Body Battle - notifications setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-push.ps1"
echo.
pause

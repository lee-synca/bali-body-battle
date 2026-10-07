@echo off
title Bali Body Battle - copy the weekly schedule
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=(Get-Content .secrets\cron-secret.txt -Raw).Trim(); (Get-Content supabase\cron.sql -Raw).Replace('YOUR-PROJECT-REF','dhtzjuoxzwlxvrzuxvsk').Replace('YOUR-CRON-SECRET',$c) | Set-Clipboard; Start-Process 'https://supabase.com/dashboard/project/dhtzjuoxzwlxvrzuxvsk/sql/new'"
echo.
echo The schedule is copied. In the Supabase SQL Editor that just opened:
echo   1. Click inside the editor and press Ctrl+V
echo   2. Press Ctrl+Enter (or click Run)
echo   3. Check the bottom says "Success". If it doesn't, press Ctrl+Enter again.
echo.
pause

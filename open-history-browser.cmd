@echo off
setlocal
cd /d "%~dp0"
start "OpenCode History Browser" /min python "%~dp0app.py"
ping 127.0.0.1 -n 2 >nul
start "" "http://127.0.0.1:8765/"

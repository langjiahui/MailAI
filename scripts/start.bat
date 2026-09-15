@echo off
chcp 65001 >nul
REM ============================================
REM MailAI 启动脚本
REM ============================================

cd /d %~dp0..

if not exist .venv\Scripts\python.exe (
    echo 未找到虚拟环境，请先运行 scripts\install.bat
    pause
    exit /b 1
)

echo 正在启动 MailAI ...
start "" http://127.0.0.1:8787
.venv\Scripts\python.exe run.py
pause

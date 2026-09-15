@echo off
chcp 65001 >nul
REM ============================================
REM MailAI 一键安装脚本（Windows）
REM 使用方法：双击运行，或在 cmd 中执行 install.bat
REM ============================================

cd /d %~dp0..

echo [1/4] 检查 Python 环境...
py --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo 未检测到 Python，请先安装 Python 3.10+：
    echo   https://www.python.org/downloads/
    echo 安装时请勾选 "Add python.exe to PATH"
    pause
    exit /b 1
)
py --version

echo.
echo [2/4] 创建虚拟环境 .venv ...
if not exist .venv (
    py -m venv .venv
) else (
    echo 虚拟环境已存在，跳过创建
)

echo.
echo [3/4] 安装依赖...
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r requirements.txt

echo.
echo [4/4] 初始化配置文件...
if not exist .env (
    copy .env.example .env >nul
    echo 已生成 .env，请用记事本打开填写你的邮箱账号和 LLM 配置：
    echo   notepad .env
) else (
    echo .env 已存在，跳过
)

echo.
echo ============================================
echo 安装完成！
echo.
echo 下一步：
echo   1. 编辑 .env 填写 IMAP_USER / IMAP_PASSWORD / LLM_API_KEY
echo   2. 双击 scripts\start.bat 启动服务
echo   3. 浏览器访问 http://127.0.0.1:8787
echo ============================================
pause

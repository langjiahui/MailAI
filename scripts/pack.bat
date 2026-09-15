@echo off
chcp 65001 >nul
REM ============================================
REM MailAI 发布包打包脚本
REM 产出干净的 zip（不含本地数据/虚拟环境/个人配置）
REM ============================================

cd /d %~dp0..
set OUT=MailAI_release.zip
if exist %OUT% del %OUT%

powershell -Command "Compress-Archive -Path app,run.py,requirements.txt,.env.example,README.md,scripts,tests -DestinationPath %OUT% -Force"

echo.
echo 已生成 %OUT%
echo 内容：app/, run.py, requirements.txt, .env.example, README.md, scripts/, tests/
echo 不包含：data/, .venv/, .env（个人数据与配置）
pause

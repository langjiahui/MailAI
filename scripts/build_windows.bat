@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0.."

REM Keep Python output deterministic across GBK and UTF-8 Windows locales.
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "MAILAI_BUILD_TEMP=%CD%\.build-temp"
if not exist "%MAILAI_BUILD_TEMP%" mkdir "%MAILAI_BUILD_TEMP%"
set "TEMP=%MAILAI_BUILD_TEMP%"
set "TMP=%MAILAI_BUILD_TEMP%"

echo ==================================================
echo MailAI Windows x64 release build
echo ==================================================

if not defined MAILAI_RELEASE_VERSION (
  for /f %%V in ('powershell -NoProfile -Command "Get-Date -Format yy.M.d.HHmm"') do set "MAILAI_RELEASE_VERSION=%%V"
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js LTS is required for frontend release checks.
  goto :failed
)

set "PY_CMD="
py -3.13 -c "import sys" >nul 2>nul && set "PY_CMD=py -3.13"
if not defined PY_CMD py -3.12 -c "import sys" >nul 2>nul && set "PY_CMD=py -3.12"
if not defined PY_CMD py -3 -c "import sys" >nul 2>nul && set "PY_CMD=py -3"
if not defined PY_CMD (
  echo [ERROR] Python 3.12 or 3.13 x64 is required.
  goto :failed
)

if not exist ".venv-build-win\Scripts\python.exe" (
  echo [1/7] Creating isolated build environment...
  %PY_CMD% -m venv .venv-build-win || goto :failed
)
set "PY=.venv-build-win\Scripts\python.exe"

echo [2/7] Installing build dependencies...
"%PY%" -m pip install --disable-pip-version-check --upgrade pip || goto :failed
"%PY%" -m pip install --disable-pip-version-check -r requirements-build.txt || goto :failed

echo [3/7] Running offline release gate...
"%PY%" scripts\check_release.py || goto :failed

echo [4/7] Preparing enterprise defaults and native icon...
"%PY%" scripts\prepare_bundle_config.py %* || goto :failed
"%PY%" scripts\prepare_app_icon.py || goto :failed
"%PY%" scripts\prepare_windows_version.py || goto :failed
set "MAILAI_ICON=%CD%\build\mailai.ico"
if not exist "%MAILAI_ICON%" (
  echo [ERROR] Native icon was not generated: %MAILAI_ICON%
  goto :failed
)

if exist "dist\windows" rmdir /s /q "dist\windows"
if exist "dist\MailAI-Windows-x64-Setup.exe" del /q "dist\MailAI-Windows-x64-Setup.exe"
echo [5/7] Building transparent application directory...
REM One-file executables unpack themselves at runtime and are frequently
REM flagged by heuristic scanners.  Keep the normal application directory and
REM let the installer deploy it; --noupx also avoids executable packer traits.
"%PY%" -m PyInstaller --noconfirm --clean --onedir --noupx --windowed --name MailAI ^
  --distpath "dist\windows" --workpath "build\windows" --specpath "build" ^
  --icon "%MAILAI_ICON%" ^
  --version-file "%CD%\build\windows-version.txt" ^
  --runtime-hook "%CD%\scripts\windows_runtime_hook.py" ^
  --hidden-import "webview.platforms.winforms" ^
  --hidden-import "webview.platforms.edgechromium" ^
  --hidden-import "pystray._win32" ^
  --hidden-import "fastembed" ^
  --hidden-import "onnxruntime" ^
  --add-data "%CD%\app\web\static;app\web\static" ^
  --add-data "%CD%\mailai.defaults.env;." ^
  --add-data "%CD%\VERSION;." ^
  run.py || goto :failed

if defined MAILAI_SIGN_SHA1 (
  where signtool.exe >nul 2>nul || goto :missing_signtool
  signtool.exe sign /sha1 "%MAILAI_SIGN_SHA1%" /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 "dist\windows\MailAI\MailAI.exe" || goto :failed
)

echo [6/7] Starting the frozen app in an isolated profile...
"%PY%" scripts\verify_windows_artifact.py || goto :failed

call :find_inno
if defined ISCC goto :inno_ready
where winget >nul 2>nul || goto :missing_inno
winget install --id JRSoftware.InnoSetup --exact --silent --accept-package-agreements --accept-source-agreements
REM An already-installed package may return nonzero. Check the actual compiler.
call :find_inno
if not defined ISCC goto :missing_inno
:inno_ready
echo Using Inno Setup compiler: "%ISCC%"
"%ISCC%" /DMyAppVersion=%MAILAI_RELEASE_VERSION% scripts\mailai.iss || goto :failed
if defined MAILAI_SIGN_SHA1 signtool.exe sign /sha1 "%MAILAI_SIGN_SHA1%" /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 "dist\MailAI-Windows-x64-Setup.exe" || goto :failed
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$zip='dist\MailAI-Windows-x64-portable.zip'; Compress-Archive -Path 'dist\windows\MailAI\*' -DestinationPath $zip -Force" || goto :failed
"%PY%" scripts\write_sha256.py "dist\windows\MailAI\MailAI.exe" "dist\MailAI-Windows-x64-Setup.exe" || goto :failed

del /q "mailai.defaults.env" >nul 2>nul
echo.
echo SUCCESS: dist\MailAI-Windows-x64-Setup.exe passed the release build.
if not defined CI pause
exit /b 0

:failed
del /q "mailai.defaults.env" >nul 2>nul
echo.
echo [FAILED] Windows release was not produced or did not pass startup verification.
if not defined CI pause
exit /b 1

:missing_signtool
echo [ERROR] MAILAI_SIGN_SHA1 is set but signtool.exe is unavailable. Install the Windows SDK.
goto :failed

:find_inno
"%PY%" scripts\find_inno_setup.py > "build\inno-compiler-path.txt"
set "ISCC="
set /p "ISCC=" < "build\inno-compiler-path.txt"
exit /b 0

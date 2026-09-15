@echo off
if defined MAILAI_BUILD_INNER goto :main
set "MAILAI_BUILD_INNER=1"
set "MAILAI_BUILD_LOG=%~dp0MailAI-Windows-build.log"
call "%~f0" > "%MAILAI_BUILD_LOG%" 2>&1
set "MAILAI_BUILD_EXIT=%ERRORLEVEL%"
type "%MAILAI_BUILD_LOG%"
echo.
echo Build log: %MAILAI_BUILD_LOG%
if not "%MAILAI_BUILD_EXIT%"=="0" echo [FAILED] Exit code: %MAILAI_BUILD_EXIT%
pause
exit /b %MAILAI_BUILD_EXIT%

:main
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

REM Python may still inherit GBK even after chcp in some Windows terminals.
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "MAILAI_BUILD_TEMP=%CD%\.build-temp"
if not exist "%MAILAI_BUILD_TEMP%" mkdir "%MAILAI_BUILD_TEMP%"
set "TEMP=%MAILAI_BUILD_TEMP%"
set "TMP=%MAILAI_BUILD_TEMP%"

set "PY_VERSION=3.13.7"
set "NODE_VERSION=22.14.0"
set "PY_HOME=%CD%\.build-python"
set "NODE_HOME=%CD%\.build-node\node-v%NODE_VERSION%-win-x64"
set "PY_INSTALLER=%TEMP%\mailai-python-%PY_VERSION%-amd64.exe"
set "NODE_ZIP=%TEMP%\mailai-node-%NODE_VERSION%-win-x64.zip"

echo ==================================================
echo MailAI Windows x64 self-contained release builder
echo ==================================================

for /f %%V in ('powershell -NoProfile -Command "Get-Date -Format yy.M.d.HHmm"') do set "MAILAI_RELEASE_VERSION=%%V"

if not exist "mailai.defaults.env" (
  echo [ERROR] mailai.defaults.env is missing from this internal build kit.
  goto :failed
)

set "PY_EXE=%CD%\.venv-build-win\Scripts\python.exe"
if not exist "%PY_EXE%" (
  py -3.14 -c "import sys; raise SystemExit(sys.maxsize.bit_length() != 63)" >nul 2>nul && py -3.14 -m venv .venv-build-win
)
if not exist "%PY_EXE%" (
  py -3.13 -c "import sys; raise SystemExit(sys.maxsize.bit_length() != 63)" >nul 2>nul && py -3.13 -m venv .venv-build-win
)
if not exist "%PY_EXE%" (
  py -3.12 -c "import sys; raise SystemExit(sys.maxsize.bit_length() != 63)" >nul 2>nul && py -3.12 -m venv .venv-build-win
)
if not exist "%PY_EXE%" (
  python -c "import sys; raise SystemExit(sys.version_info[:2] not in ((3,12),(3,13),(3,14)) or sys.maxsize.bit_length() != 63)" >nul 2>nul && python -m venv .venv-build-win
)
if exist "%PY_EXE%" (
  echo [1/9] Using local Python in .venv-build-win...
) else (
  set "PY_EXE=%PY_HOME%\python.exe"
)
if not exist "%PY_EXE%" (
  echo [1/9] Compatible local Python not found; downloading isolated Python %PY_VERSION%...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/%PY_VERSION%/python-%PY_VERSION%-amd64.exe' -OutFile '%PY_INSTALLER%'" || goto :failed
  "%PY_INSTALLER%" /quiet InstallAllUsers=0 TargetDir="%PY_HOME%" Include_pip=1 Include_test=0 Include_launcher=0 PrependPath=0 Shortcuts=0 || goto :failed
)

set "USE_SYSTEM_NODE="
node -e "const n=Number(process.versions.node.split('.')[0]);process.exit(Math.max(18,n)===n?0:1)" >nul 2>nul && set "USE_SYSTEM_NODE=1"
if defined USE_SYSTEM_NODE (
  echo [2/9] Using local Node.js...
) else if not exist "%NODE_HOME%\node.exe" (
  echo [2/9] Compatible local Node.js not found; downloading isolated Node.js %NODE_VERSION%...
  if not exist ".build-node" mkdir ".build-node"
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-win-x64.zip' -OutFile '%NODE_ZIP%'; Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '.build-node' -Force" || goto :failed
)
if not defined USE_SYSTEM_NODE set "PATH=%NODE_HOME%;%PATH%"

echo [3/9] Installing build dependencies...
"%PY_EXE%" -m pip install --disable-pip-version-check --upgrade pip || goto :failed
"%PY_EXE%" -m pip install --disable-pip-version-check -r requirements-build.txt || goto :failed

echo [4/9] Running offline release gate...
"%PY_EXE%" scripts\check_release.py || goto :failed

echo [5/9] Verifying bundled native icon...
set "MAILAI_ICON=%CD%\build\mailai.ico"
"%PY_EXE%" scripts\prepare_windows_version.py || goto :failed
REM Keep the expanded absolute path out of a parenthesized command block.
REM Extraction folders such as "MailAI (1)" would otherwise break cmd parsing.
if exist "%MAILAI_ICON%" goto :icon_ready
echo [ERROR] Bundled native icon is missing: build\mailai.ico
goto :failed

:icon_ready

if exist "dist\windows" rmdir /s /q "dist\windows"
if exist "dist\MailAI-Windows-x64-Setup.exe" del /q "dist\MailAI-Windows-x64-Setup.exe"
echo [6/9] Building transparent application directory...
REM Avoid self-extracting/packed executable traits that commonly trigger
REM heuristic antivirus detections on unsigned internal software.
"%PY_EXE%" -m PyInstaller --noconfirm --clean --onedir --noupx --windowed --name MailAI ^
  --distpath "dist\windows" --workpath "build\windows" --specpath "build" ^
  --icon "%MAILAI_ICON%" ^
  --version-file "%CD%\build\windows-version.txt" ^
  --runtime-hook "%CD%\scripts\windows_runtime_hook.py" ^
  --hidden-import "webview.platforms.winforms" ^
  --hidden-import "webview.platforms.edgechromium" ^
  --hidden-import "pystray._win32" ^
  --add-data "%CD%\app\web\static;app\web\static" ^
  --add-data "%CD%\mailai.defaults.env;." ^
  --add-data "%CD%\VERSION;." run.py || goto :failed

if defined MAILAI_SIGN_SHA1 (
  where signtool.exe >nul 2>nul || goto :missing_signtool
  echo Signing application with configured organization certificate...
  signtool.exe sign /sha1 "%MAILAI_SIGN_SHA1%" /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 "dist\windows\MailAI\MailAI.exe" || goto :failed
)

echo [7/9] Starting the frozen app in an isolated profile...
"%PY_EXE%" scripts\verify_windows_artifact.py || goto :failed

echo [8/9] Creating Windows installer...
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

if defined MAILAI_SIGN_SHA1 (
  signtool.exe sign /sha1 "%MAILAI_SIGN_SHA1%" /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 "dist\MailAI-Windows-x64-Setup.exe" || goto :failed
)

echo [9/9] Writing checksum...
"%PY%" scripts\write_sha256.py "dist\MailAI-Windows-x64-Setup.exe" || goto :failed

echo.
echo SUCCESS. Send dist\MailAI-Windows-x64-Setup.exe to the Windows tester.
exit /b 0

:missing_inno
echo [ERROR] Inno Setup 6 is required and could not be installed automatically.
goto :failed

:missing_signtool
echo [ERROR] MAILAI_SIGN_SHA1 is set but signtool.exe is unavailable. Install the Windows SDK.
goto :failed

:failed
echo.
echo [FAILED] No verified Windows release was produced.
exit /b 1

:find_inno
"%PY_EXE%" scripts\find_inno_setup.py > "build\inno-compiler-path.txt"
set "ISCC="
set /p "ISCC=" < "build\inno-compiler-path.txt"
exit /b 0

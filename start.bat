@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title Restream 42
chcp 65001 >nul 2>&1

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "RUNTIME=%ROOT%\.runtime"
if not exist "%RUNTIME%" mkdir "%RUNTIME%" >nul 2>&1

echo.
echo ==========================================
echo   Restream 42 - setup and start
echo ==========================================
echo.

rem ---------- Node.js 20+ ----------
set "NODE_EXE="
where node >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
)
if defined NODE_EXE (
  "%NODE_EXE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >nul 2>&1
  if errorlevel 1 set "NODE_EXE="
)
if not defined NODE_EXE if exist "%RUNTIME%\node\node.exe" set "NODE_EXE=%RUNTIME%\node\node.exe"
if defined NODE_EXE goto :node_ready

echo [1/4] Node.js 20+ not found. Downloading portable Node.js...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$ProgressPreference = 'SilentlyContinue';" ^
  "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
  "$release = Invoke-RestMethod 'https://nodejs.org/dist/index.json' | Where-Object { $_.lts -ne $false } | Select-Object -First 1;" ^
  "$version = $release.version;" ^
  "$zip = Join-Path $env:TEMP ('node-' + $version + '-win-x64.zip');" ^
  "Write-Host ('  Downloading Node.js ' + $version);" ^
  "Invoke-WebRequest ('https://nodejs.org/dist/' + $version + '/node-' + $version + '-win-x64.zip') -OutFile $zip;" ^
  "$tmp = Join-Path '%RUNTIME%' 'node-tmp';" ^
  "if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force };" ^
  "Expand-Archive -Path $zip -DestinationPath $tmp -Force;" ^
  "$inner = Get-ChildItem $tmp -Directory | Select-Object -First 1;" ^
  "if (-not $inner) { throw 'Node.js archive is empty' };" ^
  "$target = Join-Path '%RUNTIME%' 'node';" ^
  "if (Test-Path $target) { Remove-Item $target -Recurse -Force };" ^
  "Move-Item $inner.FullName $target;" ^
  "Remove-Item $zip -Force -ErrorAction SilentlyContinue"
if errorlevel 1 (
  echo.
  echo ERROR: Node.js could not be installed automatically.
  echo Install Node.js 20+ from https://nodejs.org and run start.bat again.
  pause
  exit /b 1
)
set "NODE_EXE=%RUNTIME%\node\node.exe"

:node_ready
for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
set "PATH=%NODE_DIR%;%PATH%"
echo [ok] Node.js:
"%NODE_EXE%" -v

rem ---------- npm dependencies ----------
set "NPM_CMD=%NODE_DIR%npm.cmd"
if not exist "%NPM_CMD%" set "NPM_CMD=npm"
set "NEED_INSTALL=0"
if not exist "node_modules\express\package.json" set "NEED_INSTALL=1"
if not exist "node_modules\node-media-server\package.json" set "NEED_INSTALL=1"
if "%NEED_INSTALL%"=="0" goto :deps_ready

echo [2/4] Installing Node dependencies...
call "%NPM_CMD%" install --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo ERROR: npm install failed. Check your internet connection and try again.
  pause
  exit /b 1
)
:deps_ready
echo [ok] Node dependencies

rem ---------- FFmpeg ----------
set "FFMPEG_EXE="
where ffmpeg >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%I in ('where ffmpeg 2^>nul') do if not defined FFMPEG_EXE set "FFMPEG_EXE=%%I"
)
if not defined FFMPEG_EXE if exist "%RUNTIME%\ffmpeg\bin\ffmpeg.exe" set "FFMPEG_EXE=%RUNTIME%\ffmpeg\bin\ffmpeg.exe"
if defined FFMPEG_EXE goto :ffmpeg_ready

echo [3/4] FFmpeg not found. Downloading FFmpeg...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$ProgressPreference = 'SilentlyContinue';" ^
  "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
  "$zip = Join-Path $env:TEMP 'ffmpeg-release-essentials.zip';" ^
  "Write-Host '  Downloading FFmpeg (about 100 MB)...';" ^
  "Invoke-WebRequest 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip;" ^
  "$tmp = Join-Path '%RUNTIME%' 'ffmpeg-tmp';" ^
  "if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force };" ^
  "Expand-Archive -Path $zip -DestinationPath $tmp -Force;" ^
  "$exe = Get-ChildItem $tmp -Recurse -Filter ffmpeg.exe | Where-Object { $_.DirectoryName -like '*\bin' } | Select-Object -First 1;" ^
  "if (-not $exe) { throw 'ffmpeg.exe not found in archive' };" ^
  "$target = Join-Path '%RUNTIME%' 'ffmpeg';" ^
  "if (Test-Path $target) { Remove-Item $target -Recurse -Force };" ^
  "New-Item -ItemType Directory -Path (Join-Path $target 'bin') -Force | Out-Null;" ^
  "Copy-Item (Join-Path $exe.DirectoryName '*') (Join-Path $target 'bin') -Recurse -Force;" ^
  "Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue;" ^
  "Remove-Item $zip -Force -ErrorAction SilentlyContinue"
if errorlevel 1 (
  echo.
  echo ERROR: FFmpeg could not be installed automatically.
  echo Install FFmpeg and add ffmpeg.exe to PATH, then run start.bat again.
  pause
  exit /b 1
)
set "FFMPEG_EXE=%RUNTIME%\ffmpeg\bin\ffmpeg.exe"

:ffmpeg_ready
for %%I in ("%FFMPEG_EXE%") do set "FFMPEG_DIR=%%~dpI"
set "PATH=%FFMPEG_DIR%;%PATH%"
set "FFMPEG_PATH=%FFMPEG_EXE%"
echo [ok] FFmpeg

rem ---------- Python 3 (Aparat only) ----------
set "PYTHON_EXE="
where python >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%I in ('where python 2^>nul') do if not defined PYTHON_EXE set "PYTHON_EXE=%%I"
)
if defined PYTHON_EXE (
  "%PYTHON_EXE%" -c "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)" >nul 2>&1
  if errorlevel 1 set "PYTHON_EXE="
)
if not defined PYTHON_EXE if exist "%RUNTIME%\python\python.exe" set "PYTHON_EXE=%RUNTIME%\python\python.exe"
if defined PYTHON_EXE goto :python_ready

echo [4/4] Python 3 not found. Downloading portable Python...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$ProgressPreference = 'SilentlyContinue';" ^
  "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
  "$zip = Join-Path $env:TEMP 'python-3.12.10-embed-amd64.zip';" ^
  "Write-Host '  Downloading Python 3.12...';" ^
  "Invoke-WebRequest 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip' -OutFile $zip;" ^
  "$target = Join-Path '%RUNTIME%' 'python';" ^
  "if (Test-Path $target) { Remove-Item $target -Recurse -Force };" ^
  "Expand-Archive -Path $zip -DestinationPath $target -Force;" ^
  "Remove-Item $zip -Force -ErrorAction SilentlyContinue"
if errorlevel 1 goto :python_failed
set "PYTHON_EXE=%RUNTIME%\python\python.exe"
goto :python_ready

:python_failed
echo [warn] Python could not be installed. Aparat relay will be unavailable.
goto :python_done

:python_ready
for %%I in ("%PYTHON_EXE%") do set "PYTHON_DIR=%%~dpI"
set "PATH=%PYTHON_DIR%;%PATH%"
set "PYTHON_PATH=%PYTHON_EXE%"
echo [ok] Python 3

:python_done
echo.

if /i "%~1"=="--setup-only" goto :setup_done
if /i "%RESTREAM_SETUP_ONLY%"=="1" goto :setup_done

rem ---------- start ----------
curl -s --max-time 2 http://127.0.0.1:9998/api/health >nul 2>&1
if not errorlevel 1 (
  echo ERROR: Restream 42 is already running on port 9998.
  echo Close the old Restream 42 window, then run start.bat again.
  pause
  exit /b 1
)

echo Starting server in THIS window: http://127.0.0.1:9998
echo Server logs stay visible here. Press Ctrl+C to stop.
echo Do not close this window while streaming.
echo.
start "" "http://127.0.0.1:9998"
"%NODE_EXE%" server\index.js
pause
exit /b 0

:setup_done
echo Setup complete.
exit /b 0

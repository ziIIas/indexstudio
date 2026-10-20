@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 goto missing_node
if exist "%~dp0app\scripts\launcher.mjs" (
  node.exe "%~dp0app\scripts\launcher.mjs" stop
) else (
  node.exe "%~dp0..\..\scripts\launcher.mjs" stop
)
set "launcher_result=%errorlevel%"
if not "%launcher_result%"=="0" pause
exit /b %launcher_result%
:missing_node
echo Install Node.js 24 LTS or newer from https://nodejs.org/en/download, then try again.
pause
exit /b 1

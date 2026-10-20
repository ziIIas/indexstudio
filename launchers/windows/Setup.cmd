@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 goto missing_node
where npm.cmd >nul 2>nul
if errorlevel 1 goto missing_node
pushd "%~dp0..\.."
call npm.cmd run setup
set "setup_result=%errorlevel%"
popd
if not "%setup_result%"=="0" pause
exit /b %setup_result%
:missing_node
echo Install Node.js 24 LTS or newer with npm from https://nodejs.org/en/download, then run setup again.
pause
exit /b 1

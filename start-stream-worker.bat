@echo off
chcp 65001 >nul
title DataSynchronizer (QuestDB Stream Worker)
cd /d "%~dp0"
setlocal EnableDelayedExpansion

set MAX_RESTARTS=10
set RESTART_DELAY=5
set STABLE_WINDOW=60
set LOG_DIR=logs
set WORKER_MODE=%~1
if "%WORKER_MODE%"=="" set WORKER_MODE=all
set MARKET_STREAM_WORKER_MODE=%WORKER_MODE%
set REDIS_MARKET_STREAM_CONSUMER=%WORKER_MODE%-%RANDOM%

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js
    exit /b 1
)

if not exist "node_modules\" (
    echo [错误] 未检测到 node_modules，请先运行 npm install
    exit /b 1
)

if not "%SKIP_BUILD%"=="1" (
    echo [提示] 正在编译 TypeScript...
    call npm run build
    if !errorlevel! neq 0 exit /b 1
)
if not exist "%LOG_DIR%\" mkdir "%LOG_DIR%"

set RESTART_COUNT=0
:RUN_LOOP
echo.
echo [Worker:%WORKER_MODE%] 第 !RESTART_COUNT! 次启动 ^| %date% %time%
node ./build/stream_worker.js
set EXIT_CODE=!errorlevel!
if !EXIT_CODE! equ 0 goto :END
set /a RESTART_COUNT+=1
if !RESTART_COUNT! gtr %MAX_RESTARTS% (
    echo [错误] Worker 连续异常退出次数超过 %MAX_RESTARTS%
    goto :END
)
timeout /t %RESTART_DELAY% /nobreak >nul
goto :RUN_LOOP

:END
endlocal
@echo off
chcp 65001 >nul
title TestGuardian
cd /d "%~dp0"
setlocal EnableDelayedExpansion

echo ========================================
echo   守护逻辑测试脚本 (mock)
echo ========================================
echo.

:: 测试参数：缩短便于快速观察
set MAX_RESTARTS=3
set RESTART_DELAY=2
set STABLE_WINDOW=5
set LOG_DIR=logs_test

if not exist "%LOG_DIR%\" mkdir "%LOG_DIR%"
for /f "tokens=1-3 delims=/-. " %%a in ('echo %date%') do set TODAY=%%a-%%b-%%c
set GUARD_LOG=%LOG_DIR%\guardian-%TODAY%.log

:: 重置 mock 计数器文件
echo 0> "%LOG_DIR%\mock_count.txt"

set RESTART_COUNT=0

:RUN_LOOP
call :GET_TIMESTAMP START_TS

echo.
echo ========================================
echo [守护] 第 !RESTART_COUNT! 次启动 ^| %time%
echo ========================================
echo [%date% %time%] [START] attempt=!RESTART_COUNT! >> "%GUARD_LOG%"

:: ---- 用 mock 程序代替 node ./build/index.js ----
:: mock 行为：读计数器，前 4 次以退出码 1 退出（模拟崩溃），第 5 次以退出码 0 退出
call :MOCK_RUN
set EXIT_CODE=!ERRORLEVEL!
:: ----------------------------------------------

call :GET_TIMESTAMP END_TS
set /a RUN_DURATION=!END_TS! - !START_TS!

echo [守护] 进程已退出 ^| 退出码=!EXIT_CODE! ^| 运行时长=!RUN_DURATION!s
echo [%date% %time%] [EXIT]  code=!EXIT_CODE! duration=!RUN_DURATION!s >> "%GUARD_LOG%"

if !EXIT_CODE! equ 0 (
    echo [守护] 进程正常退出，守护结束
    echo [%date% %time%] [STOP] normal exit >> "%GUARD_LOG%"
    goto :END
)

if !RUN_DURATION! geq %STABLE_WINDOW% (
    echo [守护] 运行时长 !RUN_DURATION!s ^>= %STABLE_WINDOW%s，重置重启计数
    set RESTART_COUNT=0
)

set /a RESTART_COUNT+=1

if !RESTART_COUNT! gtr %MAX_RESTARTS% (
    echo [错误] 已连续重启 %MAX_RESTARTS% 次仍异常退出，停止守护
    echo [%date% %time%] [STOP] max restarts reached >> "%GUARD_LOG%"
    goto :END
)

echo [守护] !RESTART_DELAY! 秒后进行第 !RESTART_COUNT!/%MAX_RESTARTS% 次重启...
timeout /t %RESTART_DELAY% /nobreak >nul
goto :RUN_LOOP

:: -------- 子例程 --------
:GET_TIMESTAMP
for /f "tokens=1-4 delims=:.," %%a in ("%time%") do (
    set /a _ts=(((1%%a-100)*60)+(1%%b-100))*60+(1%%c-100)
)
set %1=!_ts!
goto :eof

:MOCK_RUN
set /p MC=<"%LOG_DIR%\mock_count.txt"
set /a MC+=1
echo !MC!> "%LOG_DIR%\mock_count.txt"
echo [MOCK] run #!MC!
:: 模拟运行 1 秒
timeout /t 1 /nobreak >nul
if !MC! lss 4 (
    echo [MOCK] simulate crash, exit 1
    exit /b 1
)
echo [MOCK] simulate normal exit, exit 0
exit /b 0
goto :eof

:END
echo.
echo [测试完成]
echo --- 守护日志内容 ---
type "%GUARD_LOG%"
echo --- 日志结束 ---
endlocal

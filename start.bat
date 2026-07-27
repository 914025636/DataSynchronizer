@echo off
chcp 65001 >nul
title DataSynchronizer (Guardian)
cd /d "%~dp0"
setlocal EnableDelayedExpansion

echo ========================================
echo   DataSynchronizer 快速启动 (进程守护)
echo ========================================
echo.

:: ====== 守护配置 ======
:: 最大连续重启次数（达到上限后退出，防止死循环）
set MAX_RESTARTS=10
:: 重启间隔（秒）
set RESTART_DELAY=5
:: 重启计数窗口（秒），超过该时间运行视为"稳定运行"，重启计数清零
set STABLE_WINDOW=60
:: 日志目录
set LOG_DIR=logs
:: QuestDB 预检查配置
set QUESTDB_CHECK_HOST=127.0.0.1
set QUESTDB_CHECK_PORT=9009
set QUESTDB_WAIT_RETRIES=12
set QUESTDB_WAIT_INTERVAL=5
:: 设置为 1 可跳过 QuestDB 连通性检查
set SKIP_QUESTDB_CHECK=0
:: 设置为 1 可在启动前尝试通过 docker compose 启动 questdb
set USE_DOCKER_QUESTDB=0
:: ======================

:: 检查 node 是否可用
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js
    pause
    exit /b 1
)

:: 检查 node_modules 是否存在
if not exist "node_modules\" (
    echo [提示] 未检测到 node_modules，正在安装依赖...
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
    echo.
)

:: 检查 build 目录是否存在
if not exist "build\" (
    echo [提示] 未检测到 build 目录，正在编译 TypeScript...
    call npm run build
    if %errorlevel% neq 0 (
        echo [错误] 编译失败
        pause
        exit /b 1
    )
    echo.
)

:: 创建日志目录
if not exist "%LOG_DIR%\" mkdir "%LOG_DIR%"

if "%USE_DOCKER_QUESTDB%"=="1" (
    echo [提示] 正在尝试通过 docker compose 启动 QuestDB...
    docker compose up -d questdb >nul 2>nul
)

if not "%SKIP_QUESTDB_CHECK%"=="1" (
    call :WAIT_QUESTDB_READY
    if %errorlevel% neq 0 (
        echo [错误] QuestDB 未就绪，停止启动守护程序
        pause
        exit /b 1
    )
)

:: 当前日志文件（按日期分文件）
for /f "tokens=1-3 delims=/-. " %%a in ('echo %date%') do set TODAY=%%a-%%b-%%c
set GUARD_LOG=%LOG_DIR%\guardian-%TODAY%.log

set RESTART_COUNT=0

:RUN_LOOP
:: 记录启动时间戳（秒），用于判断是否"稳定运行"
call :GET_TIMESTAMP START_TS

echo.
echo ========================================
echo [守护] 第 !RESTART_COUNT! 次启动 ^| %date% %time%
echo ========================================
echo [%date% %time%] [START] attempt=!RESTART_COUNT! >> "%GUARD_LOG%"

:: 启动主进程（同步等待退出）
node ./build/index.js
set EXIT_CODE=%errorlevel%

call :GET_TIMESTAMP END_TS
set /a RUN_DURATION=!END_TS! - !START_TS!

echo.
echo [守护] 进程已退出 ^| 退出码=%EXIT_CODE% ^| 运行时长=!RUN_DURATION!s
echo [%date% %time%] [EXIT]  code=%EXIT_CODE% duration=!RUN_DURATION!s >> "%GUARD_LOG%"

:: 退出码 0：用户主动正常退出，不再重启
if %EXIT_CODE% equ 0 (
    echo [守护] 进程正常退出，守护结束
    echo [%date% %time%] [STOP] normal exit >> "%GUARD_LOG%"
    goto :END
)

:: 若运行时长超过稳定窗口，重置重启计数
if !RUN_DURATION! geq %STABLE_WINDOW% (
    echo [守护] 运行时长 !RUN_DURATION!s ^>= %STABLE_WINDOW%s，重置重启计数
    set RESTART_COUNT=0
)

set /a RESTART_COUNT+=1

:: 达到最大重启次数，停止守护
if !RESTART_COUNT! gtr %MAX_RESTARTS% (
    echo.
    echo [错误] 已连续重启 %MAX_RESTARTS% 次仍异常退出，停止守护
    echo [%date% %time%] [STOP] max restarts reached >> "%GUARD_LOG%"
    goto :END
)

echo [守护] !RESTART_DELAY! 秒后进行第 !RESTART_COUNT!/%MAX_RESTARTS% 次重启...
echo        按 Ctrl+C 可终止守护
timeout /t %RESTART_DELAY% /nobreak >nul
goto :RUN_LOOP

:WAIT_QUESTDB_READY
set /a TRY_COUNT=0
:QUESTDB_WAIT_LOOP
set /a TRY_COUNT+=1

powershell -NoProfile -Command "$c = New-Object System.Net.Sockets.TcpClient; try { $c.Connect('%QUESTDB_CHECK_HOST%', %QUESTDB_CHECK_PORT%); exit 0 } catch { exit 1 } finally { $c.Dispose() }" >nul 2>nul
if %errorlevel% equ 0 (
    echo [检查] QuestDB 已就绪：%QUESTDB_CHECK_HOST%:%QUESTDB_CHECK_PORT%
    exit /b 0
)

if %TRY_COUNT% geq %QUESTDB_WAIT_RETRIES% (
    echo [错误] QuestDB 连通性检查失败：%QUESTDB_CHECK_HOST%:%QUESTDB_CHECK_PORT%
    echo        请先启动 QuestDB，或将 SKIP_QUESTDB_CHECK 设为 1 跳过检查
    exit /b 1
)

echo [检查] 等待 QuestDB 就绪 (%TRY_COUNT%/%QUESTDB_WAIT_RETRIES%)...
timeout /t %QUESTDB_WAIT_INTERVAL% /nobreak >nul
goto :QUESTDB_WAIT_LOOP

:GET_TIMESTAMP
:: 将当前时间转为秒数（粗略，用于计算运行时长，不跨日精确）
for /f "tokens=1-4 delims=:.," %%a in ("%time%") do (
    set /a "_ts=(((1%%a-100)*60)+(1%%b-100))*60+(1%%c-100)"
)
set %1=!_ts!
goto :eof

:END
echo.
echo [结束] 守护程序已退出
pause
endlocal

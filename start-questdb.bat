@echo off
REM QuestDB 启动脚本
REM 用法: 右键 -> 以管理员身份运行

setlocal enabledelayedexpansion

set QUESTDB_PATH=D:\Program Files\questdb-9.4.3-rt-windows-x86-64

echo.
echo ========================================
echo   QuestDB 启动脚本
echo ========================================
echo.

if not exist "!QUESTDB_PATH!\bin\questdb.exe" (
    echo [ERROR] 未找到 QuestDB 可执行文件:
    echo !QUESTDB_PATH!\bin\questdb.exe
    echo.
    pause
    exit /b 1
)

echo [INFO] 启动路径: !QUESTDB_PATH!
echo [INFO] 正在启动 QuestDB...
echo.

"!QUESTDB_PATH!\bin\questdb.exe" start

if errorlevel 1 (
    echo [ERROR] 启动失败！
    echo 请确保以管理员身份运行此脚本。
    pause
    exit /b 1
)

echo.
echo [OK] QuestDB 已启动！
echo.
echo 访问 Web 控制台: http://localhost:9000
echo.
timeout /t 3

REM 自动打开浏览器
start http://localhost:9000

pause

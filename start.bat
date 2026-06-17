@echo off
chcp 65001 >nul
title DataSynchronizer
cd /d "%~dp0"

echo ========================================
echo   DataSynchronizer 快速启动
echo ========================================
echo.

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

echo [启动] 正在运行 DataSynchronizer...
echo.
node ./build/index.js

echo.
echo [结束] 程序已退出
pause

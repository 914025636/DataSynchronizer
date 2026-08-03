@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [提示] 正在编译 TypeScript...
call npm run build
if %errorlevel% neq 0 exit /b 1

set SKIP_BUILD=1
start "QuestDB Trade Worker" cmd /c "set SKIP_BUILD=1&& call start-stream-worker.bat trades"
start "QuestDB Orderbook Worker" cmd /c "set SKIP_BUILD=1&& call start-stream-worker.bat orderbook"

echo [完成] 已启动成交和订单簿独立 Worker
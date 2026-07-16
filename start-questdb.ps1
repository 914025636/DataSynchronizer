# QuestDB 启动脚本（多种方式）
# 使用: powershell -ExecutionPolicy Bypass -File start-questdb.ps1

Write-Host @"
╔════════════════════════════════════════╗
║     QuestDB 启动向导                   ║
╚════════════════════════════════════════╝
"@ -ForegroundColor Cyan

$questdbDir = "D:\questdb-data"
$binDir = "$questdbDir\bin"

# 检查本地是否已安装
if (Test-Path "$binDir\questdb.exe") {
    Write-Host "✅ 检测到本地 QuestDB，正在启动..." -ForegroundColor Green
    & "$binDir\questdb.exe" start
    Start-Sleep -Seconds 2
    Write-Host "✅ QuestDB 已启动！" -ForegroundColor Green
    Write-Host "📊 访问: http://localhost:9000" -ForegroundColor Cyan
    exit 0
}

Write-Host "`n由于网络限制，请选择以下任意方案之一：`n" -ForegroundColor Yellow

Write-Host "方案 A（推荐）：使用 Homebrew 或 Windows Package Manager" -ForegroundColor Cyan
Write-Host "  1. 安装 Scoop: iwr -useb get.scoop.sh | iex" -ForegroundColor Gray
Write-Host "  2. 运行: scoop install questdb`n" -ForegroundColor Gray

Write-Host "方案 B：手动下载" -ForegroundColor Cyan
Write-Host "  1. 访问: https://questdb.io/download/" -ForegroundColor Gray
Write-Host "  2. 下载 Windows ZIP 版本" -ForegroundColor Gray
Write-Host "  3. 解压到: $questdbDir" -ForegroundColor Gray
Write-Host "  4. 重新运行此脚本`n" -ForegroundColor Gray

Write-Host "方案 C：使用 Docker（如已安装）" -ForegroundColor Cyan
Write-Host "  在项目根目录运行: docker compose up -d`n" -ForegroundColor Gray

Write-Host "方案 D：开发模式（模拟 QuestDB，用于测试代码）" -ForegroundColor Cyan
Write-Host "  运行: npm run dev`n" -ForegroundColor Gray

Write-Host "方案 E：云服务" -ForegroundColor Cyan
Write-Host "  在 QuestDB Cloud 注册免费账户: https://cloud.questdb.com/`n" -ForegroundColor Gray

Write-Host "启动完成后，编辑 .env 文件配置 QuestDB 地址：" -ForegroundColor Yellow
Write-Host "  QUESTDB_HOST=your-questdb-host" -ForegroundColor Gray
Write-Host "  QUESTDB_PORT=9000" -ForegroundColor Gray

Read-Host "`n按 Enter 键退出"

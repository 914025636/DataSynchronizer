param(
    [string]$InstallDir = 'D:\Program Files\questdb-9.4.3-rt-windows-x86-64',
    [string]$DataDir = 'D:\QuestDBData'
)

$java = Join-Path $InstallDir 'bin\java.exe'

if (-not (Test-Path $java)) {
    throw "QuestDB Java runtime not found: $java"
}

if ((Test-NetConnection 127.0.0.1 -Port 9000 -WarningAction SilentlyContinue).TcpTestSucceeded) {
    Write-Host 'QuestDB is already running at http://127.0.0.1:9000'
    exit 0
}

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

Write-Host "Starting QuestDB with data directory: $DataDir"
& $java --enable-native-access=io.questdb -m io.questdb/io.questdb.ServerMain -d $DataDir

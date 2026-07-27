param(
    [string]$InstallDir = 'D:\Program Files\questdb-9.4.3-rt-windows-x86-64',
    [string]$DataDir = 'D:\Git\DataSynchronizer\qdbroot',
    [switch]$Restart,
    [int]$MaxWaitSeconds = 30
)

$ErrorActionPreference = 'Stop'

$questdbExe = Join-Path $InstallDir 'bin\questdb.exe'
$repoConfig = Join-Path $PSScriptRoot 'qdbroot\conf\server.conf'
$dataConfigDir = Join-Path $DataDir 'conf'
$dataConfig = Join-Path $dataConfigDir 'server.conf'

if (-not (Test-Path $questdbExe)) {
    throw "QuestDB executable not found: $questdbExe"
}

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
New-Item -ItemType Directory -Path $dataConfigDir -Force | Out-Null

# Keep runtime config deterministic: always use the repo's tuned server.conf.
if (Test-Path $repoConfig) {
    if ((Resolve-Path $repoConfig).Path -ne (Resolve-Path $dataConfig).Path) {
        Copy-Item -Path $repoConfig -Destination $dataConfig -Force
        Write-Host "Synced config: $repoConfig -> $dataConfig"
    } else {
        Write-Host "Using config in place: $dataConfig"
    }
}

if ($Restart) {
    Write-Host "Stopping QuestDB (if running) with data directory: $DataDir"
    $stopOutput = (& $questdbExe stop -d $DataDir 2>&1 | Out-String)
    $stopOutput | Out-Host
    if ($stopOutput -match 'ACCESS DENIED') {
        throw 'QuestDB stop/start requires Administrator privileges. Re-run this script in an elevated PowerShell.'
    }
}

Write-Host "Starting QuestDB with data directory: $DataDir"
$startOutput = (& $questdbExe start -d $DataDir 2>&1 | Out-String)
$startOutput | Out-Host
if ($startOutput -match 'ACCESS DENIED') {
    throw 'QuestDB stop/start requires Administrator privileges. Re-run this script in an elevated PowerShell.'
}

$httpReady = $false
$ilpReady = $false

for ($i = 0; $i -lt $MaxWaitSeconds; $i++) {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:9000/exec?query=select%201' -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            $httpReady = $true
        }
    } catch {
        $httpReady = $false
    }

    $ilpReady = (Test-NetConnection 127.0.0.1 -Port 9009 -WarningAction SilentlyContinue).TcpTestSucceeded

    if ($httpReady -and $ilpReady) {
        break
    }

    Start-Sleep -Seconds 1
}

if (-not $httpReady -or -not $ilpReady) {
    & $questdbExe status -d $DataDir | Out-Host
    throw "QuestDB health check failed. HTTP(9000)=$httpReady, ILP(9009)=$ilpReady"
}

Write-Host 'QuestDB is healthy: HTTP /exec and ILP TCP are ready.' -ForegroundColor Green

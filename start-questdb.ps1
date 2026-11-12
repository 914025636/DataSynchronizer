param(
    [string]$InstallDir = 'D:\Program Files\questdb-9.4.3-rt-windows-x86-64',
    [string]$DataDir = (Join-Path $PSScriptRoot 'qdbroot'),
    [switch]$Restart,
    [int]$MaxWaitSeconds = 60
)

$ErrorActionPreference = 'Stop'

$questdbExe = Join-Path $InstallDir 'bin\questdb.exe'
$repoConfig = Join-Path $PSScriptRoot 'qdbroot\conf\server.conf'
$dataConfigDir = Join-Path $DataDir 'conf'
$dataConfig = Join-Path $dataConfigDir 'server.conf'
$healthUri = 'http://127.0.0.1:9000/exec?query=select%201'

function Test-QuestDBHealthy {
    try {
        return (Invoke-WebRequest -Uri $healthUri -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200
    } catch {
        return $false
    }
}

# Console mode runs QuestDB as a java.exe child of questdb.exe; match it by data directory
function Get-QuestDBJava {
    $fullDataDir = [IO.Path]::GetFullPath($DataDir)
    Get-CimInstance Win32_Process -Filter "Name = 'java.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains('io.questdb') -and $_.CommandLine.Contains($fullDataDir)
    }
}

if (-not (Test-Path $questdbExe)) {
    throw "QuestDB executable not found: $questdbExe"
}

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
New-Item -ItemType Directory -Path $dataConfigDir -Force | Out-Null

# Keep runtime config deterministic: always use the repo's tuned server.conf.
if (Test-Path $repoConfig) {
    if ([IO.Path]::GetFullPath($repoConfig) -ne [IO.Path]::GetFullPath($dataConfig)) {
        Copy-Item -Path $repoConfig -Destination $dataConfig -Force
        Write-Host "Synced config: $repoConfig -> $dataConfig"
    } else {
        Write-Host "Using config in place: $dataConfig"
    }
}

if ($Restart) {
    $running = @(Get-QuestDBJava)
    if ($running.Count -gt 0) {
        Write-Host "Stopping QuestDB (pid $($running.ProcessId -join ', ')) with data directory: $DataDir"
        # Console mode has no stop command; WAL tables recover from an abrupt stop
        $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
        $running | ForEach-Object { Wait-Process -Id $_.ProcessId -Timeout 30 -ErrorAction SilentlyContinue }
    }
} elseif (Test-QuestDBHealthy) {
    Write-Host 'QuestDB is already running: HTTP /exec is ready.' -ForegroundColor Green
    return
}

# Console mode needs neither a Windows service nor Administrator rights
Write-Host "Starting QuestDB with data directory: $DataDir"
$process = Start-Process -FilePath $questdbExe -ArgumentList ('-d "{0}"' -f $DataDir) `
    -WorkingDirectory (Split-Path $questdbExe) -WindowStyle Minimized -PassThru

for ($i = 0; $i -lt $MaxWaitSeconds; $i++) {
    if (Test-QuestDBHealthy) {
        Write-Host 'QuestDB is healthy: HTTP /exec is ready.' -ForegroundColor Green
        return
    }
    if ($process.HasExited) {
        throw "QuestDB exited during startup (code $($process.ExitCode)). See logs in $(Join-Path $DataDir 'log')."
    }
    Start-Sleep -Seconds 1
}

throw "QuestDB health check failed after $MaxWaitSeconds seconds. See logs in $(Join-Path $DataDir 'log')."

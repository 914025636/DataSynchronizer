[CmdletBinding()]
param(
    [int]$DockerTimeoutSeconds = 90,
    [int]$QuestDBTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot

function Test-DockerDaemon {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    $dockerExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    return $dockerExitCode -eq 0
}

function Test-TcpPort {
    param(
        [string]$HostName,
        [int]$Port
    )

    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne(1000)) {
            return $false
        }
        $client.EndConnect($connect)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Wait-Until {
    param(
        [scriptblock]$Condition,
        [int]$TimeoutSeconds
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (& $Condition) {
            return $true
        }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)

    return $false
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found. Install Docker Desktop first.'
}

if (-not (Test-DockerDaemon)) {
    Write-Host 'Docker is not running. Starting Docker Desktop...'
    & docker desktop start
    if ($LASTEXITCODE -ne 0) {
        throw "docker desktop start failed with exit code $LASTEXITCODE."
    }

    if (-not (Wait-Until -TimeoutSeconds $DockerTimeoutSeconds -Condition { Test-DockerDaemon })) {
        throw "Docker Desktop did not become ready within $DockerTimeoutSeconds seconds."
    }
}

Push-Location $projectDirectory
try {
    Write-Host 'Starting the QuestDB Compose service...'
    & docker compose up -d redis questdb
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose up failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$containerState = (& docker inspect questdb --format '{{.State.Status}}' 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $containerState -ne 'running') {
    throw "QuestDB container is not running (state: $containerState)."
}

$container = & docker inspect questdb | ConvertFrom-Json
$dataMount = $container[0].Mounts | Where-Object { $_.Destination -eq '/var/lib/questdb' } | Select-Object -First 1
if (-not $dataMount) {
    throw 'QuestDB container has no /var/lib/questdb data mount.'
}
if ($dataMount.Type -ne 'volume' -or $dataMount.Name -notlike '*questdb_data') {
    throw "Unexpected QuestDB data mount: type=$($dataMount.Type), name=$($dataMount.Name), source=$($dataMount.Source)."
}

$ready = Wait-Until -TimeoutSeconds $QuestDBTimeoutSeconds -Condition {
    (Test-TcpPort -HostName '127.0.0.1' -Port 9009) -and
    (Test-TcpPort -HostName '127.0.0.1' -Port 18812) -and
    (Test-TcpPort -HostName '127.0.0.1' -Port 9000)
}
if (-not $ready) {
    throw "QuestDB did not expose ports 9000, 9009 and 18812 within $QuestDBTimeoutSeconds seconds. Run 'docker compose logs questdb' for details."
}

$redisReady = Wait-Until -TimeoutSeconds $QuestDBTimeoutSeconds -Condition {
    Test-TcpPort -HostName '127.0.0.1' -Port 6380
}
if (-not $redisReady) {
    throw "Redis did not expose port 6380 within $QuestDBTimeoutSeconds seconds. Run 'docker compose logs redis' for details."
}

Write-Host "QuestDB is ready. Container=$($container[0].Name.TrimStart('/')); volume=$($dataMount.Name); ILP=127.0.0.1:9009; SQL=127.0.0.1:18812; Web=http://127.0.0.1:9000; Redis=127.0.0.1:6380"
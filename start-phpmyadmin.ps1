[CmdletBinding()]
param(
    [int]$DockerTimeoutSeconds = 90,
    [int]$ServiceTimeoutSeconds = 60
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
    $dockerDesktopPaths = @(
        (Join-Path $Env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path $Env:LOCALAPPDATA 'Docker\Docker Desktop.exe')
    )
    $dockerDesktop = $dockerDesktopPaths | Where-Object { Test-Path $_ } | Select-Object -First 1

    if (-not $dockerDesktop) {
        throw 'Docker is not running and Docker Desktop was not found.'
    }

    Write-Host 'Docker is not running. Starting Docker Desktop...'
    Start-Process -FilePath $dockerDesktop | Out-Null

    if (-not (Wait-Until -TimeoutSeconds $DockerTimeoutSeconds -Condition { Test-DockerDaemon })) {
        throw "Docker Desktop did not become ready within $DockerTimeoutSeconds seconds. Check virtualization and Docker Desktop status."
    }
}

if ((Test-NetConnection 127.0.0.1 -Port 8080 -WarningAction SilentlyContinue).TcpTestSucceeded) {
    Write-Host 'phpMyAdmin is already running at http://localhost:8080.'
    exit 0
}

Push-Location $projectDirectory
try {
    Write-Host 'Starting the phpMyAdmin Compose service...'
    & docker compose up -d phpmyadmin
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose up failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

if (-not (Wait-Until -TimeoutSeconds $ServiceTimeoutSeconds -Condition {
    (Test-NetConnection 127.0.0.1 -Port 8080 -WarningAction SilentlyContinue).TcpTestSucceeded
})) {
    throw "phpMyAdmin did not listen on port 8080 within $ServiceTimeoutSeconds seconds. Run docker compose logs phpmyadmin for details."
}

Write-Host 'phpMyAdmin is ready at http://localhost:8080.'
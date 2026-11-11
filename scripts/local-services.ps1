$ErrorActionPreference = 'Stop'
$script:ProjectDirectory = Split-Path $PSScriptRoot -Parent
$script:LocalHome = if ($env:DATASYNCHRONIZER_HOME) { $env:DATASYNCHRONIZER_HOME } else { 'D:\DataSynchronizer' }
$script:LocalPrograms = Join-Path $script:LocalHome 'services'
$script:LocalData = Join-Path $script:LocalHome 'data'
$script:LocalLogs = Join-Path $script:LocalHome 'logs'
$script:LocalRun = Join-Path $script:LocalHome 'run'
$script:LocalSettings = @{}
$envPath = Join-Path $script:ProjectDirectory '.env'
if (Test-Path $envPath) {
    foreach ($line in [IO.File]::ReadAllLines($envPath)) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
            $value = $Matches[2]
            if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            if (-not $script:LocalSettings.ContainsKey($Matches[1]) -or -not $script:LocalSettings[$Matches[1]]) {
                $script:LocalSettings[$Matches[1]] = $value
            }
        }
    }
}

function Get-LocalSetting {
    param([string]$Name, [string]$Default)
    $environmentValue = [Environment]::GetEnvironmentVariable($Name)
    if ($null -ne $environmentValue) { return $environmentValue }
    if ($script:LocalSettings.ContainsKey($Name)) { return $script:LocalSettings[$Name] }
    return $Default
}

function Set-LocalEnvironment {
    foreach ($name in $script:LocalSettings.Keys) {
        [Environment]::SetEnvironmentVariable($name, $script:LocalSettings[$name])
    }
}

function Wait-LocalPort {
    param([int]$Port, [int]$TimeoutSeconds = 60)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-LocalPort $Port) { return $true }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Save-LocalProcessManifest {
    param([string]$Name, [int]$ProcessId, [string]$Executable, [int]$Port)
    New-Item -ItemType Directory -Force -Path $script:LocalRun | Out-Null
    [IO.File]::WriteAllText((Join-Path $script:LocalRun "$Name.json"), (@{ pid = $ProcessId; executable = $Executable; startedAt = [DateTime]::UtcNow.ToString('o'); port = $Port } | ConvertTo-Json))
}

function Start-LocalManagedProcess {
    param([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory, [int]$Port, [int]$TimeoutSeconds = 60)
    $portIsReady = Test-LocalPort $Port
    $manifestPath = Join-Path $script:LocalRun "$Name.json"
    $existingProcess = $null
    if ($portIsReady) {
        if (-not (Test-Path $manifestPath)) {
            throw "$Name port $Port is busy without a managed process record. Identify the existing listener before retrying."
        }
        try {
            $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
            if ($manifest.executable -ne $Executable) { throw "$Name port $Port is busy with a different executable." }
            $existingProcess = Get-Process -Id ([int]$manifest.pid) -ErrorAction Stop
        }
        catch { throw "$Name port $Port is busy with an unknown or stopped process. Identify the existing listener before retrying. $($_.Exception.Message)" }
    }
    if ($existingProcess) {
        Write-Host "[$Name] already running (PID $($existingProcess.Id))"
        return $existingProcess
    }
    if (-not (Test-Path $Executable)) { throw "$Name executable does not exist: $Executable" }
    New-Item -ItemType Directory -Force -Path $script:LocalLogs, $script:LocalRun | Out-Null
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $script:LocalLogs "$Name.stdout.log") -RedirectStandardError (Join-Path $script:LocalLogs "$Name.stderr.log")
    Save-LocalProcessManifest $Name $process.Id $Executable $Port
    if (-not (Wait-LocalPort -Port $Port -TimeoutSeconds $TimeoutSeconds)) {
        $process.Refresh()
        if ($process.HasExited) { throw "$Name exited ($($process.ExitCode)); see $script:LocalLogs\$Name.stderr.log" }
        throw "$Name did not listen on 127.0.0.1:$Port within $TimeoutSeconds seconds; see $script:LocalLogs\$Name.stderr.log"
    }
    Write-Host "[$Name] ready on 127.0.0.1:$Port (PID $($process.Id))"
    return $process
}

function Test-LocalPort {
    param([int]$Port)
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($connect)
        return $true
    }
    catch { return $false }
    finally { $client.Dispose() }
}

function Start-LocalProcess {
    param([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory, [int]$Port, [int]$TimeoutSeconds = 60)
    if (Test-LocalPort $Port) {
        Write-Host "[$Name] already listening on 127.0.0.1:$Port"
        return
    }
    if (-not (Test-Path $Executable)) { throw "$Name is not installed: $Executable" }
    New-Item -ItemType Directory -Force -Path $script:LocalLogs, $script:LocalRun | Out-Null
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $script:LocalLogs "$Name.stdout.log") -RedirectStandardError (Join-Path $script:LocalLogs "$Name.stderr.log")
    [IO.File]::WriteAllText((Join-Path $script:LocalRun "$Name.json"), (@{ pid = $process.Id; executable = $Executable; startedAt = $process.StartTime.ToUniversalTime().ToString('o'); port = $Port } | ConvertTo-Json))
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if ($process.HasExited) { throw "$Name exited with code $($process.ExitCode). See $script:LocalLogs\$Name.stderr.log" }
        if (Test-LocalPort $Port) {
            Write-Host "[$Name] ready on 127.0.0.1:$Port (PID $($process.Id))"
            return
        }
        Start-Sleep -Milliseconds 500
        $process.Refresh()
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Name did not become ready within $TimeoutSeconds seconds. See $script:LocalLogs"
}

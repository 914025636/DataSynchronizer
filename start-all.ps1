[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$mutex = [System.Threading.Mutex]::new($false, 'Local\DataSynchronizer.start-all')
$hasMutex = $false
$roles = @()

function Start-Role {
    param([hashtable]$Role)

    if ($Role.Process) {
        $Role.Process.Dispose()
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $script:nodePath
    $startInfo.Arguments = '"{0}"' -f (Join-Path $script:projectDirectory $Role.Script)
    $startInfo.WorkingDirectory = $script:projectDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false

    if ($Role.Mode) {
        $startInfo.EnvironmentVariables['MARKET_STREAM_WORKER_MODE'] = $Role.Mode
        $startInfo.EnvironmentVariables['REDIS_MARKET_STREAM_CONSUMER'] = $Role.Consumer
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Failed to start required role: $($Role.Name)"
    }

    $Role.Process = $process
    $Role.StartedAt = [DateTime]::UtcNow
    $Role.NextStart = $null
    $Role.StableReset = $false
    Write-Host "[supervisor] role started: $($Role.Name) pid=$($process.Id)"
}

Write-Host '[supervisor] starting'

try {
    try {
        $hasMutex = $mutex.WaitOne(0, $false)
    }
    catch [System.Threading.AbandonedMutexException] {
        $hasMutex = $true
    }

    if (-not $hasMutex) {
        throw 'DataSynchronizer supervisor is already running.'
    }

    $managedScripts = @('build/index.js', 'build/stream_worker.js')
    $conflicts = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $commandLine = ($_.CommandLine -replace '\\', '/').ToLowerInvariant()
        $managedScripts | Where-Object { $commandLine.Contains($_) }
    }
    if ($conflicts) {
        $processIds = ($conflicts | Select-Object -ExpandProperty ProcessId) -join ', '
        throw "Existing DataSynchronizer Node process detected (PID: $processIds). Stop the old task before starting the full supervisor."
    }

    Push-Location $projectDirectory
    try {
        & "$projectDirectory\start-questdb-docker.ps1"

        if (-not (Test-Path "$projectDirectory\node_modules")) {
            & npm.cmd install
            if ($LASTEXITCODE -ne 0) {
                throw "npm install failed with exit code $LASTEXITCODE."
            }
        }

        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $nodePath = $nodeCommand.Source
    $roles = @(
        @{ Name = 'producer'; Script = 'build\index.js'; Mode = $null; Consumer = $null; Process = $null; Restarts = 0; StartedAt = $null; NextStart = $null; StableReset = $false },
        @{ Name = 'trades'; Script = 'build\stream_worker.js'; Mode = 'trades'; Consumer = 'trades-supervised'; Process = $null; Restarts = 0; StartedAt = $null; NextStart = $null; StableReset = $false },
        @{ Name = 'orderbook'; Script = 'build\stream_worker.js'; Mode = 'orderbook'; Consumer = 'orderbook-supervised'; Process = $null; Restarts = 0; StartedAt = $null; NextStart = $null; StableReset = $false }
    )

    foreach ($role in $roles) {
        Start-Role $role
    }

    Write-Host '[supervisor] ready'

    while ($true) {
        $now = [DateTime]::UtcNow

        foreach ($role in $roles) {
            if ($role.Process -and -not $role.Process.HasExited) {
                if (-not $role.StableReset -and ($now - $role.StartedAt).TotalSeconds -ge 60) {
                    $role.Restarts = 0
                    $role.StableReset = $true
                }
                continue
            }

            if ($role.Process) {
                $exitCode = $role.Process.ExitCode
                $role.Process.Dispose()
                $role.Process = $null
                $role.Restarts += 1
                if ($role.Restarts -ge 10) {
                    throw "Required role $($role.Name) exited too often; last exit code=$exitCode."
                }
                $role.NextStart = $now.AddSeconds(5)
                Write-Warning "[supervisor] role exited: $($role.Name) code=$exitCode; restart=$($role.Restarts)/10"
            }

            if ($role.NextStart -and $now -ge $role.NextStart) {
                Start-Role $role
            }
        }

        [System.Threading.Thread]::Sleep(500)
    }
}
finally {
    foreach ($role in $roles) {
        if ($role.Process) {
            try {
                if (-not $role.Process.HasExited) {
                    $role.Process.Kill()
                    $role.Process.WaitForExit(5000) | Out-Null
                }
            }
            catch {
                Write-Warning "[supervisor] failed to stop role $($role.Name): $($_.Exception.Message)"
            }
            finally {
                $role.Process.Dispose()
            }
        }
    }

    if ($hasMutex) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
    Write-Host '[supervisor] stopped'
}
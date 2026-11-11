[CmdletBinding()]
param(
    [string]$QuestDBDataDir = '',
    [int]$ServiceTimeoutSeconds = 90
)

. (Join-Path $PSScriptRoot 'scripts\local-services.ps1')
Set-LocalEnvironment

$programs = $script:LocalPrograms
$data = $script:LocalData
$questdb = Join-Path $programs 'questdb'
$redis = Join-Path $programs 'redis\Redis-8.10.3-Windows-x64-cygwin'
$mysql = Join-Path $programs 'mysql'
$grafana = Join-Path $programs 'grafana'
$php = Join-Path $programs 'php\php.exe'
$phpMyAdmin = Join-Path $programs 'phpmyadmin'
$redisPort = [int](Get-LocalSetting 'REDIS_PORT' '6380')
$httpPort = [int](Get-LocalSetting 'QUESTDB_HTTP_PORT' '9000')
$ilpPort = [int](Get-LocalSetting 'QUESTDB_PORT' '9009')
$pgPort = [int](Get-LocalSetting 'QUESTDB_SQL_PORT' '18812')

if (-not (Test-Path (Join-Path $mysql 'bin\mysqld.exe'))) {
    throw "MySQL is not installed: $(Join-Path $mysql 'bin\mysqld.exe')"
}
if (-not (Test-Path (Join-Path $mysql 'bin\mysql.exe'))) {
    throw "MySQL client is missing: $(Join-Path $mysql 'bin\mysql.exe')"
}
if (-not (Test-Path (Join-Path $questdb 'bin\questdb.exe'))) {
    throw "QuestDB is not installed: $(Join-Path $questdb 'bin\questdb.exe')"
}
if (-not (Test-Path (Join-Path $redis 'redis-server.exe'))) {
    throw "Redis 8 Windows is not installed: $(Join-Path $redis 'redis-server.exe')"
}
if (-not (Test-Path (Join-Path $questdb 'bin\java.exe'))) {
    throw 'The QuestDB Windows distribution is missing its bundled Java runtime.'
}

$questProcess = Get-CimInstance Win32_Process -Filter "name = 'questdb.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($questdb, [StringComparison]::OrdinalIgnoreCase) }
if ($questProcess -and $questProcess.CommandLine -match '(?i)(?:\s-d\s|--dir[= ]|--root[= ])([^\s]+)') {
    $activeData = $Matches[1].Trim('"')
} else {
    $activeData = ''
}
$portIsBusy = Test-LocalPort $httpPort -or (Test-LocalPort $ilpPort) -or (Test-LocalPort $pgPort)
if ($portIsBusy -and -not $activeData -and -not $QuestDBDataDir -and -not $env:QUESTDB_DATA_DIR) {
    throw 'A QuestDB port is already in use, and its database directory cannot be identified. Set QUESTDB_DATA_DIR to the intended existing QuestDB data directory before retrying.'
}
if ($QuestDBDataDir) {
    $questData = $QuestDBDataDir
} elseif ($env:QUESTDB_DATA_DIR) {
    $questData = $env:QUESTDB_DATA_DIR
} elseif ($activeData) {
    $questData = $activeData
} elseif (Test-Path (Join-Path $questdb 'bin\qdbroot\db')) {
    $questData = Join-Path $questdb 'bin\qdbroot'
} elseif (Test-Path (Join-Path 'D:\Program Files\questdb-9.4.3-rt-windows-x86-64\bin\qdbroot\db' '.data_id')) {
    $questData = Join-Path 'D:\Program Files\questdb-9.4.3-rt-windows-x86-64\bin' 'qdbroot'
} else {
    $questData = Join-Path $data 'questdb'
    $repoData = Join-Path $PSScriptRoot 'qdbroot'
    if ((Test-Path (Join-Path $repoData 'db\.data_id')) -and -not (Test-Path (Join-Path $questData 'db\.data_id'))) {
        $repoSize = [long](Get-ChildItem $repoData -File -Recurse | Measure-Object -Property Length -Sum).Sum
        $drive = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($questData))
        $driveInfo = [IO.DriveInfo]::new($drive)
        if ($driveInfo.AvailableFreeSpace -lt ($repoSize + 1GB)) {
            throw "Not enough free disk space to make a separate QuestDB copy without touching repository data: sourceSize=$repoSize, free=$($driveInfo.AvailableFreeSpace)"
        }
        New-Item -ItemType Directory -Force -Path $questData | Out-Null
        Write-Host "Copying QuestDB data to its independent native data directory: $repoData -> $questData"
        & robocopy.exe $repoData $questData /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
        if ($LASTEXITCODE -ge 8) { throw "QuestDB data copy failed (robocopy exit $LASTEXITCODE); the original data is unchanged: $repoData" }
    }
}
$questData = [IO.Path]::GetFullPath($questData)
New-Item -ItemType Directory -Force -Path $questData | Out-Null
if ((Test-Path (Join-Path $questData 'db\.data_id')) -and -not (Test-LocalPort $pgPort)) {
    Write-Host "Using existing QuestDB data: $questData"
} elseif (-not (Test-Path (Join-Path $questData 'db\.data_id'))) {
    $canonicalNewData = [IO.Path]::GetFullPath((Join-Path $data 'questdb'))
    if ($questData -eq $canonicalNewData -and (Test-Path (Join-Path $PSScriptRoot 'qdbroot\conf\server.conf'))) {
        $targetQuestConfig = Join-Path $questData 'conf\server.conf'
        New-Item -ItemType Directory -Force -Path (Join-Path $questData 'conf') | Out-Null
        $tunedConfig = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'qdbroot\conf\server.conf'))
        foreach ($setting in @(@{ Pattern = '(?m)^#?http\.net\.bind\.to=.*$'; Value = "http.net.bind.to=127.0.0.1:$httpPort" }, @{ Pattern = '(?m)^#?line\.tcp\.net\.bind\.to=.*$'; Value = "line.tcp.net.bind.to=127.0.0.1:$ilpPort" }, @{ Pattern = '(?m)^#?pg\.net\.bind\.to=.*$'; Value = "pg.net.bind.to=127.0.0.1:$pgPort" })) {
            if ($tunedConfig -match $setting.Pattern) { $tunedConfig = [regex]::Replace($tunedConfig, $setting.Pattern, $setting.Value, 1) }
            else { $tunedConfig += "`r`n$($setting.Value)`r`n" }
        }
        [IO.File]::WriteAllText($targetQuestConfig, $tunedConfig, [Text.UTF8Encoding]::new($false))
    }
}

$questConfigSource = Join-Path $PSScriptRoot 'qdbroot\conf\server.conf'
$questConfigTarget = Join-Path $questData 'conf\server.conf'
if ((Test-Path $questConfigSource) -and (Test-Path (Join-Path $questData 'db\.data_id'))) {
    Write-Host "Keeping existing QuestDB data and config unchanged: $questData"
}

$mysqlPort = [int](Get-LocalSetting 'MYSQL_PORT' '3306')
$mysqlUser = Get-LocalSetting 'MYSQL_USER' 'root'
$mysqlPassword = Get-LocalSetting 'MYSQL_PASS' ''
$appDb = Get-LocalSetting 'MYSQL_DB' 'stockml'
$exchangeDb = Get-LocalSetting 'MYSQL_DB_EXCHANGE' 'stockml_exchange'
if ($appDb -notmatch '^[A-Za-z0-9_]+$' -or $exchangeDb -notmatch '^[A-Za-z0-9_]+$') {
    throw 'MySQL database names in .env must contain only ASCII letters, numbers, and underscores.'
}
$mysqlExe = Join-Path $mysql 'bin\mysqld.exe'
$mysqlClient = Join-Path $mysql 'bin\mysql.exe'
$mysqlData = Join-Path $data 'mysql'
$mysqlFiles = Join-Path $data 'mysql-files'
$mysqlConfig = Join-Path $script:LocalRun 'mysql.ini'
$mysqlLog = Join-Path $script:LocalLogs 'mysql.err.log'
New-Item -ItemType Directory -Force -Path $script:LocalData, $script:LocalLogs, $script:LocalRun, $mysqlFiles | Out-Null
if (-not (Test-Path $mysqlData)) { New-Item -ItemType Directory -Path $mysqlData | Out-Null }
$mysqlConfigText = @"
[mysqld]
basedir=$($mysql -replace '\\','/')
datadir=$($mysqlData -replace '\\','/')
port=$mysqlPort
bind-address=127.0.0.1
mysqlx=0
character-set-server=utf8mb4
collation-server=utf8mb4_0900_ai_ci
log-error=$($mysqlLog -replace '\\','/')
pid-file=$($script:LocalRun -replace '\\','/')/mysql.pid
secure-file-priv=$($mysqlFiles -replace '\\','/')
"@
[IO.File]::WriteAllText($mysqlConfig, $mysqlConfigText.Trim() + "`r`n", [Text.UTF8Encoding]::new($false))
$mysqlExistingPid = Join-Path $script:LocalRun 'mysql.json'
if (Test-LocalPort $mysqlPort) {
    if (-not (Test-Path $mysqlExistingPid)) {
        try {
            $tcp = Get-NetTCPConnection -State Listen -LocalPort $mysqlPort -ErrorAction Stop | Select-Object -First 1
            $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($tcp.OwningProcess)" -ErrorAction Stop
        } catch { $owner = $null }
        if ($owner -and $owner.ExecutablePath -and $owner.ExecutablePath.StartsWith($mysql, [StringComparison]::OrdinalIgnoreCase)) {
            Save-LocalProcessManifest 'mysql' $owner.ProcessId $owner.ExecutablePath $mysqlPort
        } else {
            $env:MYSQL_PWD = $mysqlPassword
            $mysqlHealth = & $mysqlClient --protocol=TCP --host=127.0.0.1 --port=$mysqlPort --user=$mysqlUser --batch --skip-column-names --execute='SELECT 1' 2>&1
            Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
            if ($LASTEXITCODE -ne 0 -or (($mysqlHealth -join '').Trim() -ne '1')) {
                throw "Port $mysqlPort is already occupied by a different service, or the existing MySQL login in .env cannot connect: $($mysqlHealth -join ' ')"
            }
            Write-Host "[MySQL] reusing existing instance on 127.0.0.1:$mysqlPort; no data or credentials changed"
        }
    }
}
if (-not (Test-LocalPort $mysqlPort)) {
    if (-not (Test-Path $mysqlExe)) { throw "MySQL server executable is missing: $mysqlExe" }
    $initialized = Test-Path (Join-Path $mysqlData 'mysql.ibd')
    if (-not $initialized) {
        $existingMysqlFiles = @(Get-ChildItem $mysqlData -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'files' })
        if ($existingMysqlFiles.Count -gt 0) {
            throw "Refusing to initialize a nonempty unrecognized MySQL data directory: $mysqlData"
        }
        Write-Host "[MySQL] initializing a fresh, empty data directory: $mysqlData"
        $initializeStdout = Join-Path $script:LocalLogs 'mysql-initialize.stdout.log'
        $initializeStderr = Join-Path $script:LocalLogs 'mysql-initialize.stderr.log'
        $initProcess = Start-Process -FilePath $mysqlExe -ArgumentList @("--defaults-file=$mysqlConfig", '--initialize-insecure', '--console') -WorkingDirectory $mysql -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput $initializeStdout -RedirectStandardError $initializeStderr
        if ($initProcess.ExitCode -ne 0 -or -not (Test-Path (Join-Path $mysqlData 'mysql.ibd'))) {
            $initializeOutput = ((Get-Content $initializeStdout -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $initializeStderr -Raw -ErrorAction SilentlyContinue)).Trim()
            throw "MySQL database initialization failed (exit $($initProcess.ExitCode)); see $initializeStdout and $initializeStderr. $($initializeOutput -replace '(?i)(password|secret)([^\r\n]{0,120})', '$1 [redacted]')"
        }
    }
    $mysqlManagedProcess = Start-LocalManagedProcess -Name 'mysql' -Executable $mysqlExe -Arguments @("--defaults-file=`"$mysqlConfig`"") -WorkingDirectory $mysql -Port $mysqlPort -TimeoutSeconds $ServiceTimeoutSeconds
    $mysqlUserSql = $mysqlUser.Replace('\','\\').Replace("'","\'")
    $mysqlPasswordSql = $mysqlPassword.Replace('\','\\').Replace("'","\'")
    $appDbSql = $appDb.Replace('`','``')
    $exchangeDbSql = $exchangeDb.Replace('`','``')
    if (-not $mysqlPassword) {
        throw 'MYSQL_PASS is empty. Set a nonempty local MySQL password in .env before initializing MySQL or starting the application.'
    }
    $mysqlSql = @"
ALTER USER '$mysqlUserSql'@'localhost' IDENTIFIED BY '$mysqlPasswordSql';
CREATE USER IF NOT EXISTS '$mysqlUserSql'@'127.0.0.1' IDENTIFIED BY '$mysqlPasswordSql';
ALTER USER '$mysqlUserSql'@'127.0.0.1' IDENTIFIED BY '$mysqlPasswordSql';
GRANT ALL PRIVILEGES ON *.* TO '$mysqlUserSql'@'127.0.0.1' WITH GRANT OPTION;
CREATE DATABASE IF NOT EXISTS ``$appDbSql`` CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS ``$exchangeDbSql`` CHARACTER SET utf8mb4;
"@
    $setupProcess = [Diagnostics.Process]::new()
    $setupProcess.StartInfo.FileName = $mysqlClient
    $setupProcess.StartInfo.Arguments = "--protocol=TCP --host=127.0.0.1 --port=$mysqlPort --user=$mysqlUser --skip-password --batch"
    $setupProcess.StartInfo.UseShellExecute = $false
    $setupProcess.StartInfo.CreateNoWindow = $true
    $setupProcess.StartInfo.RedirectStandardInput = $true
    $setupProcess.StartInfo.RedirectStandardOutput = $true
    $setupProcess.StartInfo.RedirectStandardError = $true
    if (-not $setupProcess.Start()) { throw 'Could not start the local MySQL initialization client.' }
    $setupProcess.StandardInput.WriteLine($mysqlSql)
    $setupProcess.StandardInput.Close()
    $mysqlStdout = $setupProcess.StandardOutput.ReadToEnd()
    $mysqlStderr = $setupProcess.StandardError.ReadToEnd()
    $setupProcess.WaitForExit()
    if ($setupProcess.ExitCode -ne 0) {
        $mysqlDiagnostics = ($mysqlStdout + ' ' + $mysqlStderr).Trim()
        throw "MySQL could not securely create the configured app databases/users; check .env MYSQL_USER and password. $mysqlDiagnostics"
    }
    Write-Host "[MySQL] authenticated local access configured; $appDb and $exchangeDb are ready"
} elseif (-not (Test-Path $mysqlExistingPid)) {
    Write-Host "[MySQL] reusing the existing native MySQL instance on 127.0.0.1:$mysqlPort"
}
if (Test-Path $mysqlExistingPid) {
    $mysqlManifest = Get-Content $mysqlExistingPid -Raw | ConvertFrom-Json
    try { Get-Process -Id ([int]$mysqlManifest.pid) -ErrorAction Stop | Out-Null }
    catch { throw "The MySQL listener is not the managed instance recorded in $mysqlExistingPid. Identify it before continuing." }
    $env:MYSQL_PWD = $mysqlPassword
    $mysqlHealth = & $mysqlClient --protocol=TCP --host=127.0.0.1 --port=$mysqlPort --user=$mysqlUser --batch --skip-column-names --execute='SELECT 1' 2>&1
    Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0 -or (($mysqlHealth -join '').Trim() -ne '1')) {
        throw "MySQL health check failed for the configured application user. Check the account in .env. $($mysqlHealth -join ' ')"
    }
    Write-Host "[MySQL] authenticated SQL health check passed on 127.0.0.1:$mysqlPort"
}

$redisExe = Join-Path $redis 'redis-server.exe'
$redisConfig = Join-Path $script:LocalRun 'redis.conf'
$redisConfigCygwin = '/cygdrive/' + ([IO.Path]::GetFullPath($redisConfig).Substring(0, 1).ToLowerInvariant()) + ([IO.Path]::GetFullPath($redisConfig).Substring(2) -replace '\\', '/')
$redisDataCygwin = '/cygdrive/' + ([IO.Path]::GetFullPath($script:LocalData).Substring(0, 1).ToLowerInvariant()) + ([IO.Path]::GetFullPath($script:LocalData).Substring(2) -replace '\\', '/')
New-Item -ItemType Directory -Force -Path $script:LocalRun, $script:LocalLogs, $script:LocalData | Out-Null
$redisPassword = Get-LocalSetting 'REDIS_AUTH' ''
$redisConfigLines = @(
    'bind 127.0.0.1',
    "port $redisPort",
    'protected-mode yes',
    'daemonize no',
    'save ""',
    'appendonly no',
    "dir $redisDataCygwin"
)
if ($redisPassword) { $redisConfigLines += ('requirepass "{0}"' -f $redisPassword.Replace('"', '\"')) }
[IO.File]::WriteAllLines($redisConfig, $redisConfigLines)

if (-not (Test-LocalPort $redisPort)) {
    if (-not (Test-Path $redisExe)) { throw "Redis server executable missing: $redisExe" }
    $redisProcess = Start-Process -FilePath $redisExe -ArgumentList @($redisConfigCygwin) -WorkingDirectory $redis -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $script:LocalLogs 'redis.stdout.log') -RedirectStandardError (Join-Path $script:LocalLogs 'redis.stderr.log')
    Save-LocalProcessManifest 'redis' $redisProcess.Id $redisExe $redisPort
    if (-not (Wait-LocalPort -Port $redisPort -TimeoutSeconds $ServiceTimeoutSeconds)) {
        throw "Redis failed to listen on 127.0.0.1:$redisPort. See $script:LocalLogs\redis.stderr.log"
    }
    $redisPid = $redisProcess.Id
} else {
    $redisPid = 0
    Write-Host "[Redis] already listening on 127.0.0.1:$redisPort"
}
$redisCli = Join-Path $redis 'redis-cli.exe'
$redisPingArgs = @('-h', '127.0.0.1', '-p', "$redisPort")
if ($redisPassword) { $redisPingArgs += @('-a', $redisPassword) }
$redisPing = & $redisCli @redisPingArgs PING 2>&1
if ($LASTEXITCODE -ne 0 -or ($redisPing -join '') -ne 'PONG') { throw "Redis health check failed: $redisPing" }
Write-Host "[Redis] PING passed on 127.0.0.1:$redisPort (PID $redisPid)"

if (-not $questProcess) {
    $questExe = Join-Path $questdb 'bin\questdb.exe'
    $questJava = Join-Path $questdb 'bin\java.exe'
    $svcStatus = Get-Service -Name QuestDB -ErrorAction SilentlyContinue
    if (-not $svcStatus) {
        $installResult = & $questExe install -d $questData -j $questJava 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw "QuestDB service install failed: $installResult" }
    }
    $startResult = & $questExe start -d $questData -j $questJava 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "QuestDB service start failed: $startResult" }
    Save-LocalProcessManifest 'questdb' 0 $questExe $httpPort
} else {
    Write-Host "[QuestDB] already running (PID $($questProcess.ProcessId)) with data directory $questData"
}
foreach ($port in @($httpPort, $ilpPort, $pgPort)) {
    if (-not (Wait-LocalPort -Port $port -TimeoutSeconds $ServiceTimeoutSeconds)) {
    $questProcessId = 0
        throw "QuestDB failed to listen on 127.0.0.1:$port (PID $questProcessId). See $script:LocalLogs\questdb.stderr.log"
    }
    Write-Host "[QuestDB] ready on 127.0.0.1:$port"
}
try {
    $response = Invoke-RestMethod -TimeoutSec 5 -Uri "http://127.0.0.1:$httpPort/exec?query=select%201"
    if ($response.query -ne 'select 1' -or $response.dataset[0][0] -ne 1) { throw 'Unexpected SQL result.' }
    Write-Host "[QuestDB] SQL health check passed; Web Console http://127.0.0.1:$httpPort"
} catch {
    throw "QuestDB HTTP SQL health check failed. See $script:LocalLogs\questdb.stderr.log. $($_.Exception.Message)"
}
Write-Host "[services] all native services are ready."
Write-Host "  Redis    127.0.0.1:$redisPort"
Write-Host "  MySQL    127.0.0.1:$mysqlPort  (databases: $appDb, $exchangeDb)"
Write-Host "  QuestDB  http://127.0.0.1:$httpPort  ILP=127.0.0.1:$ilpPort  PG=127.0.0.1:$pgPort"

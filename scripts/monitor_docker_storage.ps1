[CmdletBinding()]
param(
    [int]$WarningFreeGiB = 150,
    [int]$CriticalFreeGiB = 100,
    [int]$WarningGrowthGiBPerHour = 1,
    [int]$CriticalGrowthGiBPerHour = 5
)

$ErrorActionPreference = 'Stop'
$vhdxPath = 'D:\DockerData\wsl\DockerDesktopWSL\disk\docker_data.vhdx'
$drive = Get-PSDrive D
$status = 'OK'
$warnings = @()

function Format-Bytes {
    param([double]$Bytes)
    if ($Bytes -ge 1TB) { return ('{0:N2} TiB' -f ($Bytes / 1TB)) }
    if ($Bytes -ge 1GB) { return ('{0:N2} GiB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N2} MiB' -f ($Bytes / 1MB)) }
    return ('{0:N2} KiB' -f ($Bytes / 1KB))
}

function Add-Warning {
    param([string]$Message, [bool]$Critical = $false)
    $script:warnings += $Message
    if ($Critical) { $script:status = 'CRITICAL' }
    elseif ($script:status -eq 'OK') { $script:status = 'WARNING' }
}

Write-Host "Storage monitor: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

if (Test-Path $vhdxPath) {
    $vhdx = Get-Item $vhdxPath
    Write-Host "VHDX: $($vhdxPath) / $(Format-Bytes $vhdx.Length)"
    Write-Host "VHDX last write: $($vhdx.LastWriteTime)"
} else {
    Add-Warning "VHDX not found: $vhdxPath" $true
}

$freeGiB = $drive.Free / 1GB
Write-Host ("D: used={0}, free={1}" -f (Format-Bytes $drive.Used), (Format-Bytes $drive.Free))
if ($freeGiB -lt $CriticalFreeGiB) { Add-Warning "D: free space below ${CriticalFreeGiB} GiB" $true }
elseif ($freeGiB -lt $WarningFreeGiB) { Add-Warning "D: free space below ${WarningFreeGiB} GiB" $false }

try {
    Write-Host "`nDocker volumes:"
    docker system df -v
} catch {
    Add-Warning "docker system df failed: $($_.Exception.Message)" $true
}

try {
    $redis = docker exec datasynchronizer-redis redis-cli INFO persistence
    $aofEnabled = ([string](($redis | Where-Object { $_ -match '^aof_enabled:' } | Select-Object -First 1) -replace '^aof_enabled:', '')).Trim()
    $aofSizeText = ([string](($redis | Where-Object { $_ -match '^aof_current_size:' } | Select-Object -First 1) -replace '^aof_current_size:', '')).Trim()
    $rdbSave = ([string](($redis | Where-Object { $_ -match '^rdb_bgsave_in_progress:' } | Select-Object -First 1) -replace '^rdb_bgsave_in_progress:', '')).Trim()
    $aofSize = 0
    [void][int64]::TryParse($aofSizeText, [ref]$aofSize)
    Write-Host "`nRedis: aof_enabled=$aofEnabled, aof_current_size=$(Format-Bytes ([double]$aofSize)), rdb_bgsave_in_progress=$rdbSave"
    if ($aofEnabled -ne '0') { Add-Warning 'Redis AOF is enabled' $false }
} catch {
    Add-Warning "Redis status failed: $($_.Exception.Message)" $false
}

try {
    Write-Host "`nQuestDB tables:"
    $query = "SELECT table_name, table_row_count, table_min_timestamp, table_max_timestamp FROM tables() WHERE table_type = 'T' ORDER BY table_name"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($query))
    $result = Invoke-RestMethod -Uri "http://127.0.0.1:9000/exec?query=$([Uri]::EscapeDataString($query))" -Method Get
    $result.dataset | ForEach-Object {
        [pscustomobject]@{
            table_name = $_[0]
            table_row_count = $_[1]
            table_min_timestamp = $_[2]
            table_max_timestamp = $_[3]
        }
    } | Format-Table -AutoSize
} catch {
    Add-Warning "QuestDB table status failed: $($_.Exception.Message)" $false
}

if ($warnings.Count -gt 0) {
    Write-Host "`n${status}:"
    $warnings | ForEach-Object { Write-Warning $_ }
} else {
    Write-Host "`n${status}: no threshold violations"
}

if ($status -eq 'CRITICAL') { exit 2 }
if ($status -eq 'WARNING') { exit 1 }
exit 0
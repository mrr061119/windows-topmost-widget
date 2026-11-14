<#
.SYNOPSIS
  DSH 下载任务的置顶进度显示（推送到 topmost-widget）。

.DESCRIPTION
  topmost-widget 没在跑时静默失败，绝不因为显示层挂了中断下载。

.EXAMPLE
  .\widget-dl.ps1 start -Id "npm:bridge" -Name "npm install dsh-qq-bridge" -Total 0

.EXAMPLE
  .\widget-dl.ps1 update -Id "npm:bridge" -Done 1234567 -Total 4567890

.EXAMPLE
  .\widget-dl.ps1 done -Id "npm:bridge"

.EXAMPLE
  .\widget-dl.ps1 fail -Id "npm:bridge" -Message "EADDRINUSE"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('start', 'update', 'done', 'fail', 'clear', 'watch')]
    [string]$Action,

    [Parameter(Mandatory)]
    [string]$Id,

    [string]$Name,

    [long]$Done = 0,
    [long]$Total = 0,

    # 0 = 让脚本自己按两次采样算速度
    [double]$Speed = 0,

    [string]$Message,

    # watch 用：盯着这个文件的大小自动算进度（字节）
    [string]$WatchPath
)

$ErrorActionPreference = 'SilentlyContinue'

$port = if ($env:WIDGET_PORT) { $env:WIDGET_PORT } else { '7788' }
$base = "http://127.0.0.1:$port"

$stateDir = Join-Path $env:TEMP 'widget-dl'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$stateFile = Join-Path $stateDir (($Id -replace '[^\w.-]', '_') + '.json')

$DONE_TTL_MS = 8000

# ---------------------------------------------------------------- helpers

function Format-Bytes([double]$b) {
    if ($b -ge 1GB) { return ('{0:N2} GB' -f ($b / 1GB)) }
    if ($b -ge 1MB) { return ('{0:N2} MB' -f ($b / 1MB)) }
    if ($b -ge 1KB) { return ('{0:N1} KB' -f ($b / 1KB)) }
    return ('{0:N0} B' -f $b)
}

function Format-Eta([double]$sec) {
    if (-not ($sec -gt 0) -or [double]::IsInfinity($sec)) { return '--' }
    if ($sec -ge 3600) { return ('{0:N0}h {1:N0}m' -f [math]::Floor($sec / 3600), [math]::Floor(($sec % 3600) / 60)) }
    if ($sec -ge 60) { return ('{0:N0}m {1:N0}s' -f [math]::Floor($sec / 60), [math]::Floor($sec % 60)) }
    return ('{0:N0}s' -f [math]::Ceiling($sec))
}

function Push-Block([string]$blockId, $Block, [int]$TtlMs = 0) {
    # 下载块统一排在会话状态下面；块内再按后缀细分，保证 title→bar→meta→speed 的固定顺序
    if ($Block -is [hashtable] -and -not $Block.ContainsKey('priority')) {
        $suffix = ($blockId -split ':')[-1]
        $Block.priority = switch ($suffix) {
            'title' { 50.0 }
            'bar' { 50.1 }
            'meta' { 50.2 }
            'speed' { 50.3 }
            default { 50.5 }
        }
    }
    $body = @{ id = $blockId; block = $Block }
    if ($TtlMs -gt 0) { $body.ttl_ms = $TtlMs }
    try {
        $json = $body | ConvertTo-Json -Depth 6 -Compress
        Invoke-RestMethod -Method Post -Uri "$base/api/v1/patch" `
            -ContentType 'application/json; charset=utf-8' `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) `
            -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Remove-Block([string]$blockId) {
    try {
        $json = @{ id = $blockId; remove = $true } | ConvertTo-Json -Compress
        Invoke-RestMethod -Method Post -Uri "$base/api/v1/patch" `
            -ContentType 'application/json; charset=utf-8' `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) `
            -TimeoutSec 2 | Out-Null
    } catch { }
}

function Read-State {
    if (Test-Path $stateFile) {
        try { return Get-Content $stateFile -Raw | ConvertFrom-Json } catch { }
    }
    return $null
}

function Save-State($s) {
    try { $s | ConvertTo-Json -Depth 5 -Compress | Set-Content -Path $stateFile -Encoding utf8NoBOM } catch { }
}

function Now-Ms { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

# ---------------------------------------------------------------- actions

$prefix = "dl:${Id}:"
$idTitle = "${prefix}title"
$idBar = "${prefix}bar"
$idMeta = "${prefix}meta"
$idSpeed = "${prefix}speed"

switch ($Action) {

    'clear' {
        foreach ($k in $idTitle, $idBar, $idMeta, $idSpeed) { Remove-Block $k }
        Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
        return
    }

    # 盯着一个正在增长的文件，自己算进度、自己收尾。
    # 调用方不用再关心 update/done，单位也由这里统一按字节算。
    'watch' {
        if (-not $WatchPath) { throw '-WatchPath 必填（要盯的文件路径）' }

        & $PSCommandPath start -Id $Id -Name $Name -Total $Total | Out-Null

        $last = -1
        $stable = 0
        $leaf = Split-Path $WatchPath -Leaf

        while ($true) {
            $size = 0
            if (Test-Path $WatchPath) {
                try { $size = (Get-Item $WatchPath).Length } catch { }
            }

            & $PSCommandPath update -Id $Id -Done $size -Total $Total | Out-Null

            if ($size -eq $last) { $stable++ } else { $stable = 0; $last = $size }

            # 文件连续 6 秒不再增长，且没有 curl 在写它，就算下完
            $writing = Get-CimInstance Win32_Process -Filter "Name='curl.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -and $_.CommandLine.Contains($leaf) }

            if ($stable -ge 3 -and -not $writing) {
                if ($size -gt 0) {
                    & $PSCommandPath done -Id $Id -Done $size | Out-Null
                } else {
                    & $PSCommandPath fail -Id $Id -Message '文件一直是空的（下载可能失败了）' | Out-Null
                }
                break
            }

            Start-Sleep -Seconds 2
        }
        return
    }

    'start' {
        $now = Now-Ms
        Save-State ([pscustomobject]@{
                id = $Id; name = $Name; total = $Total; done = $Done
                startMs = $now; lastMs = $now; lastDone = $Done; emaSpeed = 0
            })

        $title = if ($Name) { $Name } else { $Id }

        Push-Block $idTitle @{ kind = 'text'; text = $title; size = 13; weight = 'bold' } | Out-Null
        Push-Block $idBar @{ kind = 'progress'; label = $(if ($Total -gt 0) { '下载中' } else { '下载中 · 总量未知' }); value = 0 } | Out-Null
        Push-Block $idMeta @{ kind = 'row'; label = '已下载'; text = $(if ($Total -gt 0) { "$(Format-Bytes $Done) / $(Format-Bytes $Total)" } else { (Format-Bytes $Done) }) } | Out-Null
        Push-Block $idSpeed @{ kind = 'row'; label = '速度'; text = '-- /s' } | Out-Null
        return
    }

    'update' {
        $s = Read-State
        $now = Now-Ms
        if (-not $s) {
            $s = [pscustomobject]@{
                id = $Id; name = $Name; total = $Total; done = 0
                startMs = $now; lastMs = $now; lastDone = $Done; emaSpeed = 0
            }
        }

        $dt = ($now - $s.lastMs) / 1000.0
        if ($Speed -gt 0) {
            $spd = $Speed
        } elseif ($dt -ge 0.15) {
            $inst = ($Done - $s.lastDone) / $dt
            if ($inst -lt 0) { $inst = 0 }
            $prev = [double]$s.emaSpeed
            $spd = if ($prev -le 0) { $inst } else { 0.65 * $prev + 0.35 * $inst }
        } else {
            $spd = [double]$s.emaSpeed
        }

        $tot = if ($Total -gt 0) { $Total } elseif ($s.total -gt 0) { [long]$s.total } else { 0 }

        $s.lastMs = $now
        $s.lastDone = $Done
        $s.emaSpeed = $spd
        if ($tot -gt 0) { $s.total = $tot }
        Save-State $s

        # 注意：不能用 [Math]::Min(1, $ratio) —— PowerShell 会选 Min(int,int) 重载，
        # 0.8 被四舍五入成 1，百分比只会是 0 或 100。必须显式 double + 手写 clamp。
        $ratio = 0.0
        if ($tot -gt 0) { $ratio = [double]$Done / [double]$tot }
        if ($ratio -lt 0) { $ratio = 0 }
        if ($ratio -gt 1) { $ratio = 1 }
        $pct = [int][Math]::Round($ratio * 100)
        $eta = if ($tot -gt 0 -and $spd -gt 0) { ($tot - $Done) / $spd } else { 0 }

        Push-Block $idBar @{
            kind  = 'progress'
            label = $(if ($tot -gt 0) { "下载中 · $pct%" } else { '下载中 · 总量未知' })
            value = $ratio
        } | Out-Null

        Push-Block $idMeta @{
            kind  = 'row'
            label = '已下载'
            text  = $(if ($tot -gt 0) { "$(Format-Bytes $Done) / $(Format-Bytes $tot)" } else { (Format-Bytes $Done) })
        } | Out-Null

        $speedText = if ($spd -gt 0) {
            "$(Format-Bytes $spd)/s" + $(if ($eta -gt 0) { " · 剩余 $(Format-Eta $eta)" } else { '' })
        } else { '-- /s' }

        Push-Block $idSpeed @{ kind = 'row'; label = '速度'; text = $speedText } | Out-Null
        return
    }

    'done' {
        $s = Read-State
        $elapsed = if ($s) { ((Now-Ms) - $s.startMs) / 1000.0 } else { 0 }
        $avg = if ($elapsed -gt 0 -and $Done -gt 0) { $Done / $elapsed } else { 0 }
        $title = if ($Name) { $Name } elseif ($s) { $s.name } else { $Id }

        Push-Block $idTitle @{ kind = 'text'; text = $title; size = 13; weight = 'bold'; color = '#4ade80' } $DONE_TTL_MS | Out-Null
        Push-Block $idBar @{ kind = 'progress'; label = '完成'; value = 1; color = '#4ade80' } $DONE_TTL_MS | Out-Null
        Push-Block $idMeta @{
            kind = 'row'; label = '已下载'; color = '#4ade80'
            text = "$(Format-Bytes $Done)" + $(if ($elapsed -gt 0) { " · 耗时 $(Format-Eta $elapsed)" } else { '' })
        } $DONE_TTL_MS | Out-Null
        Push-Block $idSpeed @{ kind = 'row'; label = '平均'; text = $(if ($avg -gt 0) { "$(Format-Bytes $avg)/s" } else { '--' }) } $DONE_TTL_MS | Out-Null

        Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
        return
    }

    'fail' {
        $title = if ($Name) { $Name } else { $Id }
        Push-Block $idTitle @{ kind = 'text'; text = $title; size = 13; weight = 'bold'; color = '#f87171' } | Out-Null
        Push-Block $idBar @{ kind = 'progress'; label = '失败'; value = 0; color = '#f87171' } | Out-Null
        Push-Block $idMeta @{ kind = 'row'; label = '原因'; text = $(if ($Message) { $Message } else { '未知错误' }); color = '#f87171' } | Out-Null
        Push-Block $idSpeed @{ kind = 'row'; label = '已下载'; text = (Format-Bytes $Done) } | Out-Null

        Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
        return
    }
}

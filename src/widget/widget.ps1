<#
.SYNOPSIS
  topmost-widget 的 PowerShell 客户端。

.DESCRIPTION
  默认连 http://127.0.0.1:7788，可用环境变量 WIDGET_PORT 覆盖。

.EXAMPLE
  .\widget.ps1 health

.EXAMPLE
  # 全量渲染
  .\widget.ps1 render -Json '{"title":"DSH","accent":"#5ac8fa","blocks":[{"id":"a","kind":"text","text":"正在构建"}]}'

.EXAMPLE
  # 只更新一个块（推荐多调用方使用）
  .\widget.ps1 set -Id status -Kind row -Label 任务 -Text "正在构建"

.EXAMPLE
  .\widget.ps1 toast "构建完成" -Kind ok

.EXAMPLE
  .\widget.ps1 rm -Id status
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('health', 'state', 'render', 'set', 'rm', 'toast', 'show', 'hide', 'bounds', 'quit')]
    [string]$Action = 'health',

    [string]$Json,
    [string]$Id,
    [Parameter(Position = 1)]
    [string]$Text,
    # block 类型：text / row / progress / image / divider；toast 时用作 info / ok / warn / err
    [string]$Kind = 'text',
    [string]$Label,
    [double]$Value = 0,
    [string]$Color,
    [int]$TtlMs = 0,
    [int]$Width = 0,
    [int]$Height = 0,
    [int]$X = [int]::MinValue,
    [int]$Y = [int]::MinValue
)

$ErrorActionPreference = 'Stop'

$port = if ($env:WIDGET_PORT) { $env:WIDGET_PORT } else { '7788' }
$base = "http://127.0.0.1:$port"

function Invoke-Widget {
    param([string]$Method, [string]$Path, $Body)
    $params = @{
        Uri                = "$base$Path"
        Method             = $Method
        ContentType        = 'application/json; charset=utf-8'
        TimeoutSec         = 5
    }
    if ($null -ne $Body) {
        $params.Body = ([System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 10 -Compress)))
    }
    Invoke-RestMethod @params
}

switch ($Action) {
    'health' { Invoke-Widget GET '/health' $null | ConvertTo-Json -Depth 5 }
    'state'  { Invoke-Widget GET '/api/v1/state' $null | ConvertTo-Json -Depth 10 }

    'render' {
        if (-not $Json) { throw '-Json 必填，例如 {"blocks":[...]}' }
        Invoke-Widget POST '/api/v1/render' ($Json | ConvertFrom-Json) | ConvertTo-Json -Compress
    }

    'set' {
        if (-not $Id) { throw '-Id 必填' }
        $block = @{ kind = $Kind }
        if ($Label) { $block.label = $Label }
        if ($Text) { $block.text = $Text }
        if ($PSBoundParameters.ContainsKey('Value')) { $block.value = $Value }
        if ($Color) { $block.color = $Color }
        $body = @{ id = $Id; block = $block }
        if ($TtlMs -gt 0) { $body.ttl_ms = $TtlMs }
        Invoke-Widget POST '/api/v1/patch' $body | ConvertTo-Json -Compress
    }

    'rm' {
        if (-not $Id) { throw '-Id 必填' }
        Invoke-Widget POST '/api/v1/patch' @{ id = $Id; remove = $true } | ConvertTo-Json -Compress
    }

    'toast' {
        if (-not $Text) { throw '-Text 必填' }
        $allowed = @('info', 'ok', 'warn', 'err')
        $body = @{ text = $Text; kind = $(if ($allowed -contains $Kind) { $Kind } else { 'info' }) }
        if ($TtlMs -gt 0) { $body.ttl_ms = $TtlMs }
        Invoke-Widget POST '/api/v1/toast' $body | ConvertTo-Json -Compress
    }

    'show' { Invoke-Widget POST '/api/v1/visibility' @{ visible = $true } | ConvertTo-Json -Compress }
    'hide' { Invoke-Widget POST '/api/v1/visibility' @{ visible = $false } | ConvertTo-Json -Compress }

    'bounds' {
        $body = @{}
        if ($X -ne [int]::MinValue) { $body.x = $X }
        if ($Y -ne [int]::MinValue) { $body.y = $Y }
        if ($Width -gt 0) { $body.width = $Width }
        if ($Height -gt 0) { $body.height = $Height }
        Invoke-Widget POST '/api/v1/window' $body | ConvertTo-Json -Compress
    }

    'quit' { Invoke-Widget POST '/api/v1/quit' $null | ConvertTo-Json -Compress }
}

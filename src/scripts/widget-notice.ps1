<#
.SYNOPSIS
  把一条提醒推到 topmost-widget（置顶窗口），需要用户注意的事用它。

.DESCRIPTION
  - 写一块 `notice:<Id>`，常驻直到 -Clear。
  - 同类提醒用同一个 Id 会覆盖，不同 Id 并存。
  - widget 没起时静默失败，不影响调用方。

.EXAMPLE
  # 要动鼠标前打一声招呼（等用户回话）
  .\widget-notice.ps1 -Id mouse -Kind warn -Text "我要动一下鼠标做拖动测试，约 2 秒"

.EXAMPLE
  # 用户回话了，清掉
  .\widget-notice.ps1 -Id mouse -Clear

.EXAMPLE
  # 普通提示，60 秒自动消失
  .\widget-notice.ps1 -Id build -Kind info -Text "构建完成" -TtlMs 60000
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Text,

    [ValidateSet('info', 'warn', 'err')]
    [string]$Kind = 'warn',

    [string]$Id = 'default',

    [string]$Label,

    [int]$TtlMs = 0,

    [switch]$Clear
)

$ErrorActionPreference = 'SilentlyContinue'

$port = if ($env:WIDGET_PORT) { $env:WIDGET_PORT } else { '7788' }
$base = "http://127.0.0.1:$port"
$blockId = "notice:$Id"

function Post($obj) {
    try {
        Invoke-RestMethod -Method Post -Uri "$base/api/v1/patch" `
            -ContentType 'application/json; charset=utf-8' `
            -Body ([System.Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 6 -Compress))) `
            -TimeoutSec 3 | Out-Null
        return $true
    } catch {
        return $false
    }
}

if ($Clear) {
    Post @{ id = $blockId; remove = $true } | Out-Null
    return
}

if (-not $Text) { throw '-Text 必填（或者用 -Clear）' }

$palette = @{
    info = @{ color = '#5ac8fa'; label = '提醒' }
    warn = @{ color = '#fbbf24'; label = '需要你确认' }
    err  = @{ color = '#f87171'; label = '出错了' }
}
$p = $palette[$Kind]

$body = @{
    id    = $blockId
    block = @{
        kind     = 'row'
        label    = $(if ($Label) { $Label } else { $p.label })
        text     = $Text
        color    = $p.color
        priority = 5
    }
}
if ($TtlMs -gt 0) { $body.ttl_ms = $TtlMs }

if (Post $body) { "pushed $blockId" } else { "widget offline, skipped" }

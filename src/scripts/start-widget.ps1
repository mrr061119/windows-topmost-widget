<#
.SYNOPSIS
  启动 topmost-widget，并脱离当前进程的 Job Object。

.DESCRIPTION
  用 Start-Process 从 DSH 的工具调用里拉起，进程会落进 DSH 的 Job Object，
  DSH 一重启就被连坐杀掉（日志里连 quitting 都来不及写）。

  这里改用 WMI Win32_Process.Create，进程挂到 WmiPrvSE.exe 下，
  父进程链是 electron → WmiPrvSE → svchost → services，跟 DSH 无关。

.EXAMPLE
  .\start-widget.ps1
#>
[CmdletBinding()]
param(
    # 默认取本脚本上一级的 widget/，也就是仓库里的 src/widget
    [string]$AppDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'widget'),
    [int]$TimeoutSeconds = 25,
    [int]$Port = 7788
)

$ErrorActionPreference = 'Continue'

$exe = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
$app = $AppDir

function Test-WidgetPort {
    return [bool](Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue)
}

if (Test-WidgetPort) {
    "already running on $Port"
    exit 0
}

if (-not (Test-Path $exe)) {
    "missing: $exe"
    exit 1
}

$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = "`"$exe`" `"$app`""
}

if ($r.ReturnValue -ne 0) {
    "WMI create failed: ReturnValue=$($r.ReturnValue)"
    exit 1
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    if (Test-WidgetPort) {
        "started: pid $($r.ProcessId), port $Port ready"
        exit 0
    }
    Start-Sleep -Milliseconds 300
}

"started: pid $($r.ProcessId) but port $Port not ready within ${TimeoutSeconds}s"
"check: $(Join-Path $AppDir 'logs\widget.log')"
exit 1

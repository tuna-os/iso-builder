# Runs one UI smoke scenario of TunaOS Media Writer and fails if the app does.
#   pwsh smoke/run-ui-smoke.ps1 -App path\TunaOSMediaWriter.exe -Out dir -Scenario write -FakeHelper smoke\fake-helper.ps1
# The app walks the flow itself (`--smoke`), writes <Out>/<Scenario>/*.png + smoke.log and exits.
param(
    [Parameter(Mandatory)] [string] $App,
    [Parameter(Mandatory)] [string] $Out,
    [ValidateSet('write', 'error', 'save', 'launch')] [string] $Scenario = 'write',
    [string] $FakeHelper,
    [switch] $NoElevate,
    [int] $TimeoutSeconds = 240
)
$ErrorActionPreference = 'Stop'

$dir = Join-Path $Out $Scenario
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$argv = @('--smoke', $dir, '--smoke-scenario', $Scenario, '--smoke-timeout', [string]($TimeoutSeconds - 30))
if ($FakeHelper) { $argv += @('--fake-helper', (Resolve-Path $FakeHelper).Path) }
if ($NoElevate) { $argv += '--no-elevate' }

Write-Host "> $App $($argv -join ' ')"
$p = Start-Process -FilePath $App -ArgumentList ($argv | ForEach-Object { '"' + $_ + '"' }) -PassThru
$null = $p.Handle # without this, ExitCode is empty after WaitForExit (Start-Process quirk)
if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Write-Host "::error::UI smoke '$Scenario' did not exit within $TimeoutSeconds s"
    $code = 124
} else {
    $code = $p.ExitCode
}

$log = Join-Path $dir 'smoke.log'
if (Test-Path $log) { Get-Content $log | ForEach-Object { Write-Host "  $_" } } else { Write-Host '  (no smoke.log written)' }
Get-ChildItem $dir -Filter *.png | ForEach-Object { Write-Host "  screenshot: $($_.Name) ($([math]::Round($_.Length / 1KB)) KB)" }

if ($code -ne 0) {
    Write-Host "::error::UI smoke '$Scenario' failed with exit code $code"
    exit 1
}
Write-Host "UI smoke '$Scenario' passed"

param([switch]$Stop)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'config.json'))) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config.example.json') -Destination (Join-Path $PSScriptRoot 'config.json')
}
$widget = Join-Path $PSScriptRoot 'bin\TokenWidget.exe'
if (-not (Test-Path -LiteralPath $widget)) { & (Join-Path $PSScriptRoot 'build-widget.ps1') }
if ($Stop) { Start-Process -FilePath $widget -ArgumentList '--quit' -WindowStyle Hidden }
else { Start-Process -FilePath $widget -WorkingDirectory $PSScriptRoot -WindowStyle Normal }

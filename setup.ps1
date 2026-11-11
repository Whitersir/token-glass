param([switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$config = Join-Path $PSScriptRoot 'config.json'
if (-not (Test-Path -LiteralPath $config)) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config.example.json') -Destination $config }
$node = $null
$saved = Join-Path $PSScriptRoot 'node-path.txt'
if (Test-Path -LiteralPath $saved) {
    $candidate = (Get-Content -LiteralPath $saved -Raw).Trim().Trim([char]0xFEFF)
    if (Test-Path -LiteralPath $candidate) { $node = $candidate }
}
if (-not $node) {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { $node = $command.Source }
}
if (-not $node) { throw 'Node.js 20+ is required. Install it from https://nodejs.org/ and run setup.ps1 again.' }
$version = & $node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [int]($version.Split('.')[0]) -lt 20) { throw 'Node.js 20 or later is required.' }
& (Join-Path $PSScriptRoot 'build-widget.ps1')
& $node (Join-Path $PSScriptRoot 'src\prepare-browser-extension.js')
if ($LASTEXITCODE -ne 0) { throw 'Browser extension setup failed.' }
Write-Host 'Token Glass is ready. Chrome extension loading is optional; see README.md.'
if (-not $NoLaunch) { & (Join-Path $PSScriptRoot 'start.ps1') }

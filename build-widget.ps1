param([switch]$Test, [switch]$SkipComposition)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
$wpf = Join-Path $framework 'WPF'
New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'bin') -Force | Out-Null
$references = @(
    (Join-Path $wpf 'PresentationCore.dll'),
    (Join-Path $wpf 'PresentationFramework.dll'),
    (Join-Path $wpf 'WindowsBase.dll'),
    (Join-Path $framework 'System.Xaml.dll'),
    (Join-Path $framework 'System.Web.Extensions.dll'),
    (Join-Path $framework 'System.Windows.Forms.dll'),
    (Join-Path $framework 'System.Drawing.dll'),
    (Join-Path $framework 'System.Runtime.dll'),
    (Join-Path $framework 'System.Runtime.WindowsRuntime.dll'),
    (Join-Path $framework 'System.Numerics.Vectors.dll'),
    (Join-Path $framework 'System.Numerics.dll'),
    (Join-Path $env:WINDIR 'System32\WinMetadata\Windows.Foundation.winmd'),
    (Join-Path $env:WINDIR 'System32\WinMetadata\Windows.Graphics.winmd'),
    (Join-Path $env:WINDIR 'System32\WinMetadata\Windows.UI.winmd')
)
$arguments = @('/nologo','/target:winexe','/platform:x64','/optimize+','/codepage:65001','/out:bin\TokenWidget.exe','/win32manifest:native\app.manifest')
foreach ($reference in $references) { $arguments += '/reference:' + $reference }
if ($Test) {
    $arguments = $arguments | Where-Object { $_ -notlike '/target:*' -and $_ -notlike '/out:*' }
    $arguments += @('/target:exe', '/out:bin\WidgetLifecycleTests.exe', '/main:LocalTokenWidget.WidgetLifecycleTests', 'test\WidgetLifecycleTests.cs')
}
$arguments += 'native\TokenWidget.cs'
$arguments += 'native\CompositionBackdrop.cs'
& $compiler $arguments
if ($LASTEXITCODE -ne 0) { throw 'Widget build failed.' }
if ($Test) {
    if ($SkipComposition) { & (Join-Path $PSScriptRoot 'bin\WidgetLifecycleTests.exe') --skip-composition }
    else { & (Join-Path $PSScriptRoot 'bin\WidgetLifecycleTests.exe') }
    if ($LASTEXITCODE -ne 0) { throw 'Widget lifecycle tests failed.' }
} else { Write-Host 'Built bin\TokenWidget.exe' }

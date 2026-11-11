param([switch]$Disable, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$target = Join-Path $PSScriptRoot 'bin\TokenWidget.exe'
if (-not (Test-Path -LiteralPath $target)) { throw 'Build the widget first.' }
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'Codex Token Widget.lnk'
$shell = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $shortcutPath) {
    $existing = $shell.CreateShortcut($shortcutPath)
    if ($existing.TargetPath -ne $target) { throw 'An unrelated startup shortcut has the same name; it was left unchanged.' }
}
if ($Disable) {
    if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath }
    Start-Process -FilePath $target -ArgumentList '--quit' -WindowStyle Hidden
    Write-Host 'Codex Token Widget autostart disabled.'
} else {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $target
    $shortcut.WorkingDirectory = $PSScriptRoot
    $shortcut.Description = 'Local token widget; shows only while Codex is open.'
    $shortcut.IconLocation = "$target,0"
    $shortcut.WindowStyle = 1
    $shortcut.Save()
    if (-not $NoLaunch) { Start-Process -FilePath $target -WorkingDirectory $PSScriptRoot -WindowStyle Normal }
    Write-Host 'Codex Token Widget autostart enabled.'
}

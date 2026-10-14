param([switch]$IncludeMV2Fallback, [string]$ExtensionDirectory = 'extension')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseDirectory = Join-Path $projectPath 'releases'
[void][IO.Directory]::CreateDirectory($releaseDirectory)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$version = (Get-Content -LiteralPath (Join-Path $projectPath 'extension\manifest.json') -Raw | ConvertFrom-Json).version
$sourceVersion = (Get-Content -LiteralPath (Join-Path $projectPath 'package.json') -Raw | ConvertFrom-Json).version
function WriteZip([string]$Destination, [string[]]$Files, [string]$ManifestOverride) {
    $stream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew)
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($relative in $Files) {
            $entry = $zip.CreateEntry($relative.Replace('\', '/'))
            $output = $entry.Open()
            try {
                if ($ManifestOverride -and $relative -eq 'manifest.json') {
                    $bytes = [Text.Encoding]::UTF8.GetBytes($ManifestOverride)
                } else { $bytes = [IO.File]::ReadAllBytes((Join-Path $projectPath $relative)) }
                $output.Write($bytes, 0, $bytes.Length)
            } finally { $output.Dispose() }
        }
    } finally { $zip.Dispose(); $stream.Dispose() }
    Write-Host $Destination
}
# Extension archive has manifest at its root for temporary loading after unzip.
$extensionPath = [IO.Path]::GetFullPath((Join-Path $projectPath $ExtensionDirectory))
if ($extensionPath -ne (Join-Path $projectPath 'extension') -and -not $extensionPath.StartsWith($releaseDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'ExtensionDirectory must be the source extension or a prepared build under releases.' }
$extensionFiles = @('manifest.json', 'server-config.js', 'background.js', 'content.js', 'engine.js', 'popup.css', 'popup.html', 'popup.js', 'remote-ui.js', 'assets/radtv-logo.svg')
$version = (Get-Content -LiteralPath (Join-Path $extensionPath 'manifest.json') -Raw | ConvertFrom-Json).version
function ExtensionZip([string]$Name, [string]$ManifestOverride) {
    $destination = Join-Path $releaseDirectory $Name
    $stream = [IO.File]::Open($destination, [IO.FileMode]::CreateNew)
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $extensionFiles) {
            $entry = $zip.CreateEntry($file.Replace('\', '/')); $output = $entry.Open()
            try {
                $bytes = if ($ManifestOverride -and $file -eq 'manifest.json') { [Text.Encoding]::UTF8.GetBytes($ManifestOverride) } else { [IO.File]::ReadAllBytes((Join-Path $extensionPath $file)) }
                $output.Write($bytes, 0, $bytes.Length)
            } finally { $output.Dispose() }
        }
        $licenseEntry = $zip.CreateEntry('LICENSE'); $licenseOutput = $licenseEntry.Open()
        try { $licenseBytes = [IO.File]::ReadAllBytes((Join-Path $projectPath 'LICENSE')); $licenseOutput.Write($licenseBytes, 0, $licenseBytes.Length) }
        finally { $licenseOutput.Dispose() }
    } finally { $zip.Dispose(); $stream.Dispose() }
    Write-Host $destination
}
ExtensionZip "uburoom-extension-$version-$stamp.zip" ''
# Explicit whitelist: never package credentials, certificates, node_modules or device data.
$trackedFiles = @(& git -C $projectPath ls-files)
if ($LASTEXITCODE -ne 0) { throw 'Source packaging requires an audited Git checkout.' }
$sourceFiles = @($trackedFiles | Where-Object { (Test-Path -LiteralPath (Join-Path $projectPath $_) -PathType Leaf) -and ($_ -in @('README.md','SPEC.md','AGENTS.md','LICENSE','package.json','package-lock.json','.env.example','.gitignore','run-uburoom.bat','install-uburoom.bat','test-uburoom.bat','run-watch-demo.bat','run-radtv.bat','install-radtv.bat','test-radtv.bat') -or $_ -match '^(assets|extension|server|web|scripts|tests|docs)/') -and ($_ -eq '.env.example' -or ($_ -notmatch '(^|/)\.env($|\.)' -and $_ -notmatch '\.(key|pem|pfx|p12|sqlite|db|zip|log)$')) })
WriteZip (Join-Path $releaseDirectory "uburoom-source-$sourceVersion-$stamp.zip") $sourceFiles ''
if ($IncludeMV2Fallback) {
    $manifest = Get-Content -LiteralPath (Join-Path $extensionPath 'manifest.json') -Raw | ConvertFrom-Json
    $manifest.manifest_version = 2
    $manifest.name = 'uburoom MV2 persistent fallback'
    $manifest.background | Add-Member -NotePropertyName persistent -NotePropertyValue $true -Force
    $manifest.permissions = @($manifest.permissions) + @($manifest.host_permissions)
    $manifest.PSObject.Properties.Remove('host_permissions')
    $manifest | Add-Member -NotePropertyName browser_action -NotePropertyValue $manifest.action
    $manifest.PSObject.Properties.Remove('action')
    $manifest.content_security_policy = $manifest.content_security_policy.extension_pages
    $manifest.web_accessible_resources = @('assets/radtv-logo.svg')
    ExtensionZip "uburoom-mv2-persistent-fallback-$stamp.zip" ($manifest | ConvertTo-Json -Depth 10)
}

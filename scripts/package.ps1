[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$projectPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseDirectory = Join-Path $projectPath 'releases'
[void][IO.Directory]::CreateDirectory($releaseDirectory)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$version = (Get-Content -LiteralPath (Join-Path $projectPath 'package.json') -Raw | ConvertFrom-Json).version
# Explicit whitelist: extension builds belong to the independent remote repository.
$trackedFiles = @(& git -C $projectPath ls-files)
if ($LASTEXITCODE -ne 0) { throw 'Source packaging requires an audited Git checkout.' }
$sourceFiles = @($trackedFiles | Where-Object {
  (Test-Path -LiteralPath (Join-Path $projectPath $_) -PathType Leaf) -and
  ($_ -in @('README.md','ROADMAP.md','SPEC.md','AGENTS.md','LICENSE','package.json','package-lock.json','config.example.yaml','.gitignore','.gitattributes','run-uburoom.bat','install-uburoom.bat','test-uburoom.bat','run-watch-demo.bat') -or $_ -match '^(assets|shared|server|web|diagnostics|scripts|tests|docs)/') -and
  ($_ -eq 'config.example.yaml' -or ($_ -notmatch '(^|/)\.env($|\.)' -and $_ -notmatch '(?i)\.(yaml|yml|key|pem|pfx|p12|sqlite|db|zip|log)$'))
})
$destination = Join-Path $releaseDirectory "uburoom-source-$version-$stamp.zip"
$stream = [IO.File]::Open($destination, [IO.FileMode]::CreateNew)
$zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in $sourceFiles) {
    $entry = $zip.CreateEntry($file.Replace('\', '/'))
    $output = $entry.Open()
    try {
      $bytes = [IO.File]::ReadAllBytes((Join-Path $projectPath $file))
      $output.Write($bytes, 0, $bytes.Length)
    } finally { $output.Dispose() }
  }
} finally { $zip.Dispose(); $stream.Dispose() }
Write-Host $destination

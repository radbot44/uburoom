# Builds uburoom-tray.exe using the inbox .NET Framework 4.x C# compiler (zero external SDKs).
[CmdletBinding()]
param(
  [string]$OutPath = '',
  [string]$IconPath = ''
)

$ErrorActionPreference = 'Stop'

$trayDir = $PSScriptRoot
$repoRoot = [IO.Path]::GetFullPath((Join-Path $trayDir '..\..'))
$sourceFile = Join-Path $trayDir 'Program.cs'

if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
  throw "Missing tray source file: $sourceFile"
}

if (-not $OutPath) {
  $OutPath = Join-Path $trayDir 'build\uburoom-tray.exe'
}
$OutPath = [IO.Path]::GetFullPath($OutPath)

if (-not $IconPath) {
  $IconPath = Join-Path $repoRoot 'assets\branding\uburoom-icon-windows.ico'
}
if (-not $IconPath -or -not (Test-Path -LiteralPath $IconPath -PathType Leaf)) {
  throw "Missing tray icon file: $IconPath"
}
$IconPath = [IO.Path]::GetFullPath($IconPath)

$cscCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$cscExe = $null
foreach ($candidate in $cscCandidates) {
  if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    $cscExe = $candidate
    break
  }
}
if (-not $cscExe) {
  $fromPath = Get-Command csc.exe -ErrorAction SilentlyContinue
  if ($fromPath) { $cscExe = $fromPath.Source }
}
if (-not $cscExe) {
  throw 'Could not locate .NET Framework 4.x csc.exe.'
}

$pkg = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$rawVersion = [string]$pkg.version
$numericVersion = if ($rawVersion -match '^(\d+\.\d+\.\d+)') { "$($Matches[1]).0" } else { '0.0.0.0' }

$outDir = [IO.Path]::GetDirectoryName($OutPath)
[void][IO.Directory]::CreateDirectory($outDir)

$stageDir = Join-Path ([IO.Path]::GetTempPath()) ("uburoom-tray-build-" + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($stageDir)
try {
  $assemblyInfo = Join-Path $stageDir 'AssemblyInfo.cs'
  $assemblyInfoContent = @"
using System.Reflection;

[assembly: AssemblyTitle("uburoom")]
[assembly: AssemblyDescription("System-tray launcher for uburoom")]
[assembly: AssemblyProduct("uburoom")]
[assembly: AssemblyCopyright("GPL-3.0-only")]
[assembly: AssemblyVersion("$numericVersion")]
[assembly: AssemblyFileVersion("$numericVersion")]
[assembly: AssemblyInformationalVersion("$rawVersion")]
"@
  [IO.File]::WriteAllText($assemblyInfo, $assemblyInfoContent, [Text.UTF8Encoding]::new($false))

  $cscArgs = @(
    '/nologo',
    '/codepage:65001',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/warnaserror+',
    "/win32icon:$IconPath",
    "/resource:$IconPath,uburoom.ico",
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    "/out:$OutPath",
    $sourceFile,
    $assemblyInfo
  )

  & $cscExe @cscArgs
  if ($LASTEXITCODE -ne 0) {
    throw "csc.exe failed with exit code $LASTEXITCODE"
  }
} finally {
  if (Test-Path -LiteralPath $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Output $OutPath

param([string[]]$DnsNames = @('localhost'), [string]$CertificateDirectory = 'certs')
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'new-dev-cert.js'
$names = @($DnsNames | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$argsList = @($scriptPath, '--directory', $CertificateDirectory)
if ($names.Count -gt 0) {
    $argsList += @('--dnsNames', ($names -join ','))
}
& node @argsList
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

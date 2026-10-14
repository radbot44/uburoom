param([string[]]$DnsNames = @('localhost'), [string]$CertificateDirectory = 'certs')
$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$certDirectory = [IO.Path]::GetFullPath((Join-Path $projectPath $CertificateDirectory))
if ((Test-Path -LiteralPath (Join-Path $certDirectory 'server-key.pem')) -or (Test-Path -LiteralPath (Join-Path $certDirectory 'server-cert.pem'))) {
    throw 'A certificate already exists. Keep it, or move those files aside before generating another.'
}
# Use the Windows/.NET certificate API in memory, without installing a trust root.
# PKCS#1 encoding below also works with Windows PowerShell 5.1.
function DerLength([int]$Length) {
    if ($Length -lt 128) { return ,([byte[]]@($Length)) }
    $bytes = [Collections.Generic.List[byte]]::new()
    while ($Length -gt 0) { $bytes.Insert(0, [byte]($Length -band 255)); $Length = $Length -shr 8 }
    return ,([byte[]](@([byte](128 + $bytes.Count)) + $bytes.ToArray()))
}
function DerWrap([byte]$Tag, [byte[]]$Bytes) {
    return ,([byte[]](@($Tag) + (DerLength $Bytes.Length) + $Bytes))
}
function DerInteger([byte[]]$Bytes) {
    $offset = 0
    while ($offset -lt ($Bytes.Length - 1) -and $Bytes[$offset] -eq 0) { $offset++ }
    $value = [byte[]]$Bytes[$offset..($Bytes.Length - 1)]
    if ($value[0] -ge 128) { $value = [byte[]](@(0) + $value) }
    return ,(DerWrap 2 $value)
}
function Pem([string]$Label, [byte[]]$Bytes) {
    $base64 = [Convert]::ToBase64String($Bytes)
    $lines = [Collections.Generic.List[string]]::new()
    $lines.Add("-----BEGIN $Label-----")
    for ($i = 0; $i -lt $base64.Length; $i += 64) { $lines.Add($base64.Substring($i, [Math]::Min(64, $base64.Length - $i))) }
    $lines.Add("-----END $Label-----")
    return ($lines -join "`n") + "`n"
}
$rsa = [Security.Cryptography.RSACryptoServiceProvider]::new(2048)
$rsa.PersistKeyInCsp = $false
$subject = [Security.Cryptography.X509Certificates.X500DistinguishedName]::new('CN=uburoom LAN development')
$request = [Security.Cryptography.X509Certificates.CertificateRequest]::new($subject, $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
$san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
foreach ($name in $DnsNames) { $san.AddDnsName($name) }
$san.AddIpAddress([Net.IPAddress]::Parse('127.0.0.1'))
$request.CertificateExtensions.Add($san.Build())
$eku = [Security.Cryptography.OidCollection]::new()
[void]$eku.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
$request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $false))
$certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(365))
$parameters = $rsa.ExportParameters($true)
$keyData = [Collections.Generic.List[byte]]::new()
$keyData.AddRange((DerInteger ([byte[]]@(0))))
foreach ($field in @('Modulus', 'Exponent', 'D', 'P', 'Q', 'DP', 'DQ', 'InverseQ')) { $keyData.AddRange((DerInteger $parameters.$field)) }
$privateKey = DerWrap 48 $keyData.ToArray()
[void][IO.Directory]::CreateDirectory($certDirectory)
[IO.File]::WriteAllText((Join-Path $certDirectory 'server-key.pem'), (Pem 'RSA PRIVATE KEY' $privateKey), [Text.Encoding]::ASCII)
[IO.File]::WriteAllText((Join-Path $certDirectory 'server-cert.pem'), (Pem 'CERTIFICATE' $certificate.RawData), [Text.Encoding]::ASCII)
[IO.File]::WriteAllBytes((Join-Path $certDirectory 'radtv-lan.cer'), $certificate.RawData)
$certificate.Dispose()
$rsa.Dispose()
Write-Host "Created local TLS files in $certDirectory. No certificate was installed in any trust store."
Write-Host 'In Firefox, visit the exact HTTPS setup URL and add a certificate exception after checking radtv-lan.cer.'
Write-Host 'Never share server-key.pem. This self-signed leaf certificate is not a root CA.'

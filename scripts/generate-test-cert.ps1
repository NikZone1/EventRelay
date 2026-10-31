
$ErrorActionPreference = "Stop"

$certDir = Join-Path $PSScriptRoot "..\tests\certs"
$keyPath = Join-Path $certDir "localhost-key.pem"
$certPath = Join-Path $certDir "localhost-cert.pem"

New-Item -ItemType Directory -Path $certDir -Force | Out-Null

$rsa = [System.Security.Cryptography.RSA]::Create(2048)

$subject = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new(
    "CN=localhost"
)

$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    $subject,
    $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)

$san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName("localhost")
$san.AddIpAddress([System.Net.IPAddress]::Parse("127.0.0.1"))
$request.CertificateExtensions.Add($san.Build())

$basicConstraints = [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new(
    $false,
    $false,
    0,
    $true
)
$request.CertificateExtensions.Add($basicConstraints)

$keyUsage = [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment,
    $true
)
$request.CertificateExtensions.Add($keyUsage)

$notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
$notAfter = $notBefore.AddDays(365)

$certificate = $request.CreateSelfSigned($notBefore, $notAfter)


# Export certificate as PEM.
$certBytes = $certificate.Export(
    [System.Security.Cryptography.X509Certificates.X509ContentType]::Cert
)

$certBase64 = [Convert]::ToBase64String(
    $certBytes,
    [Base64FormattingOptions]::InsertLineBreaks
)

$certPem = "-----BEGIN CERTIFICATE-----`n$certBase64`n-----END CERTIFICATE-----`n"

# Export the matching private key as PKCS#8 PEM.
$keyBytes = $rsa.ExportPkcs8PrivateKey()

$keyBase64 = [Convert]::ToBase64String(
    $keyBytes,
    [Base64FormattingOptions]::InsertLineBreaks
)

$keyPem = "-----BEGIN PRIVATE KEY-----`n$keyBase64`n-----END PRIVATE KEY-----`n"

[System.IO.File]::WriteAllText($certPath, $certPem)
[System.IO.File]::WriteAllText($keyPath, $keyPem)

$certificate.Dispose()
$rsa.Dispose()

Write-Host "Generated local HTTPS test certificate:"
Write-Host $certPath
Write-Host $keyPath

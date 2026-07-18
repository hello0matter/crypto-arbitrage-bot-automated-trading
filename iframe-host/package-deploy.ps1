$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root "dist"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stage = Join-Path $dist "iframe-host-package"
$archive = Join-Path $dist ("iframe-host-" + $stamp + ".zip")

if (Test-Path $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force
}

New-Item -ItemType Directory -Path $stage | Out-Null

$items = @(
    "check-config.js",
    "config.example.json",
    "package.json",
    "package-lock.json",
    "README.md",
    "server.js",
    "deploy"
)

foreach ($item in $items) {
    Copy-Item -LiteralPath (Join-Path $root $item) -Destination $stage -Recurse -Force
}

if (Test-Path $archive) {
    Remove-Item -LiteralPath $archive -Force
}

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $archive -CompressionLevel Optimal
Remove-Item -LiteralPath $stage -Recurse -Force

Write-Host ("Created archive: " + $archive)

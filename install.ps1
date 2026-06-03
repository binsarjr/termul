# Termul installer for Windows.
#
#   irm https://raw.githubusercontent.com/binsarjr/termul/main/install.ps1 | iex
#
# Pulls the matching installer from the latest GitHub release and runs it.
# Windows builds are unsigned, so SmartScreen may warn on first launch
# (More info -> Run anyway). Overridable via env: TERMUL_REPO, TERMUL_VERSION.

#Requires -Version 5
$ErrorActionPreference = 'Stop'

$Repo    = if ($env:TERMUL_REPO)    { $env:TERMUL_REPO }    else { 'binsarjr/termul' }
$Version = if ($env:TERMUL_VERSION) { $env:TERMUL_VERSION } else { 'latest' }

function Info($m) { Write-Host "==> $m" -ForegroundColor Green }
function Warn($m) { Write-Host "warning: $m" -ForegroundColor Yellow }

$api = if ($Version -eq 'latest') {
  "https://api.github.com/repos/$Repo/releases/latest"
} else {
  "https://api.github.com/repos/$Repo/releases/tags/$Version"
}

$headers = @{ 'User-Agent' = 'termul-installer'; 'Accept' = 'application/vnd.github+json' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }

Info "Termul installer ($Repo @ $Version)"
$release = Invoke-RestMethod -Uri $api -Headers $headers

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne 'AMD64') { Warn "only x64 Windows assets are published; '$arch' may not work" }

# Prefer the NSIS setup.exe (current-user, silent-capable); fall back to the MSI.
$asset = $release.assets | Where-Object { $_.name -match '_x64-setup\.exe$' } | Select-Object -First 1
if (-not $asset) {
  $asset = $release.assets | Where-Object { $_.name -match '_x64.*\.msi$' } | Select-Object -First 1
}
if (-not $asset) { throw "No Windows installer asset in release $($release.tag_name)" }

$dest = Join-Path $env:TEMP $asset.name
Info "Downloading $($asset.name)"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -Headers $headers

Info "Running installer"
if ($asset.name -match '\.msi$') {
  Start-Process msiexec.exe -ArgumentList "/i `"$dest`" /passive" -Wait
} else {
  # NSIS: /S runs the bundled current-user install silently.
  Start-Process -FilePath $dest -ArgumentList '/S' -Wait
}

Info "Installed Termul $($release.tag_name)"
Info "Launch it from the Start menu."

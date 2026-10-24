# Builds a portable Windows app in dist\IPL Auction Room-win32-x64 and zips it.
# Uses Electron's manual packaging layout (prebuilt runtime + resources\app), which avoids
# @electron/packager's zip extraction step that exits silently on recent Node versions.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'node_modules\electron\package.json') -Raw | ConvertFrom-Json).version
$appName = 'IPL Auction Room'
$out = Join-Path $root "dist\$appName-win32-x64"

# Download (or reuse the cached) Electron runtime zip.
$zip = node -e "require('@electron/get').downloadArtifact({ version: '$version', platform: 'win32', arch: 'x64', artifactName: 'electron' }).then(p => console.log(p))"
if (-not (Test-Path $zip)) { throw "Electron runtime zip not found: $zip" }

if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force $out | Out-Null
Expand-Archive -Path $zip -DestinationPath $out -Force
Rename-Item (Join-Path $out 'electron.exe') "$appName.exe"
Remove-Item (Join-Path $out 'resources\default_app.asar') -ErrorAction SilentlyContinue

$app = Join-Path $out 'resources\app'
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item (Join-Path $root 'package.json') $app
foreach ($dir in 'desktop', 'server', 'shared', 'web') { Copy-Item -Recurse (Join-Path $root $dir) $app }

# Runtime packages the game server needs (ws, the Anthropic SDK and their dependencies).
Push-Location $root
$deps = npm ls --omit=dev --all --parseable | Where-Object { $_ -match 'node_modules' }
Pop-Location
foreach ($dep in $deps) {
  $rel = $dep.Substring($dep.IndexOf('node_modules'))
  $dest = Join-Path $app $rel
  if (Test-Path $dest) { continue }
  New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
  Copy-Item -Recurse $dep $dest
}

$zipOut = Join-Path $root "dist\$appName-win32-x64.zip"
if (Test-Path $zipOut) { Remove-Item -Force $zipOut }
Compress-Archive -Path $out -DestinationPath $zipOut
Write-Host "Built: $out\$appName.exe"
Write-Host "Zipped: $zipOut"

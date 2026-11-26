# Builds the release zip for one CPU: roost.exe, the official Node.js, the bundled host and the install scripts.
#   pwsh scripts/package.ps1 -Arch x64 -Exe app/target/x86_64-pc-windows-msvc/release/roost.exe
# Output: dist/Roost-<version>-win-<arch>.zip and its .sha256 (the checksum install.ps1 checks).
param(
  [Parameter(Mandatory)] [ValidateSet('x64', 'arm64')] [string] $Arch,
  [Parameter(Mandatory)] [string] $Exe,
  [string] $NodeVersion = 'v24.22.0'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content "$root/host/package.json" -Raw | ConvertFrom-Json).version
$work = Join-Path $root "dist/stage-$Arch"
$out = Join-Path $work 'Roost'
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $out, "$out/node", "$out/host" | Out-Null

# The official Node.js for Windows, checked against nodejs.org's published checksums.
$zipName = "node-$NodeVersion-win-$Arch.zip"
$nodeZip = Join-Path $work $zipName
Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/$zipName" -OutFile $nodeZip
$sums = (Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt").Content
$expected = ($sums -split "`n" | Where-Object { $_ -match "  $([regex]::Escape($zipName))$" }) -replace '\s.*$', ''
$actual = (Get-FileHash $nodeZip -Algorithm SHA256).Hash.ToLower()
if (-not $expected -or $actual -ne $expected.Trim().ToLower()) { throw "Node.js checksum mismatch for $zipName" }
Expand-Archive $nodeZip -DestinationPath $work
Copy-Item (Join-Path $work "node-$NodeVersion-win-$Arch/node.exe") "$out/node/node.exe"
Copy-Item (Join-Path $work "node-$NodeVersion-win-$Arch/LICENSE") "$out/node/LICENSE"

# The host, bundled into one file with the Control Center next to it.
Push-Location "$root/host"
node scripts/bundle.mjs
Pop-Location
Copy-Item -Recurse "$root/host/dist/*" "$out/host/"

Copy-Item $Exe "$out/roost.exe"
Set-Content -Path "$out/VERSION" -Value $version -NoNewline -Encoding ascii
foreach ($f in 'install.ps1', 'uninstall.ps1') {
  if (Test-Path "$root/site/$f") { Copy-Item "$root/site/$f" "$out/$f" }
}
Copy-Item "$root/LICENSE", "$root/NOTICE", "$root/THIRD_PARTY.md" $out

New-Item -ItemType Directory -Force -Path "$root/dist" | Out-Null
$zip = Join-Path $root "dist/Roost-$version-win-$Arch.zip"
Remove-Item -Force $zip -ErrorAction SilentlyContinue
Compress-Archive -Path "$out/*" -DestinationPath $zip
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Set-Content -Path "$zip.sha256" -Value "$hash  $(Split-Path -Leaf $zip)" -NoNewline -Encoding ascii
Write-Host "Built $zip ($hash)"

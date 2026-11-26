# Roost installer for Windows.
#
#   irm https://just-rice.github.io/roost/install.ps1 | iex
#
# What it does, in order:
#   1. checks this PC runs Windows 10 version 1903 (build 18362) or later, or Windows 11, and whether it has an
#      x64 (Intel/AMD) or an ARM64 processor;
#   2. asks GitHub for the latest Roost release (or the version in $env:ROOST_VERSION);
#   3. downloads Roost-<version>-win-<x64|arm64>.zip and its .sha256 checksum, and stops unless they match;
#   4. unpacks it into a folder next to the install folder and checks it contains roost.exe;
#   5. closes Roost if it's running, swaps the new copy in for %LOCALAPPDATA%\Programs\Roost (the old copy is kept
#      until the new one is in place, and put back if anything goes wrong);
#   6. makes Roost start with Windows (the HKCU Run key), unless "Control admin apps" is on, in which case Roost's
#      own scheduled task \Roost\Roost starts it and the Run key is left alone;
#   7. starts Roost. The first time, it opens its Control Center in your browser.
#
# Files fetched by PowerShell aren't marked "downloaded from the internet" (no Mark-of-the-Web), which is why
# Windows SmartScreen doesn't stop roost.exe with "Windows protected your PC" even though Roost isn't signed with
# a paid code-signing certificate. Everything is per user: it never needs administrator rights and never asks for
# them. Uses only what every Windows 10 has (Windows PowerShell 5.1 and its built-in cmdlets). Your settings and
# pairings live in %LOCALAPPDATA%\Roost and are not touched.
#
# Options: -Update (quiet; used by Roost's own "Update" menu item), -NoStart, -Dir <folder>.
# Piped into iex there is nowhere to put options, so to pass them, run it as a script block:
#
#   & ([scriptblock]::Create((irm https://just-rice.github.io/roost/install.ps1))) -NoStart
#
# or save it and run: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
#
# For tests: $env:ROOST_RELEASES_API points it at a local copy of GitHub's releases API (and only then may downloads
# use plain http), $env:ROOST_VERSION asks for a particular version instead of the latest.
#
# This file is plain ASCII on purpose: Windows PowerShell 5.1 reads a .ps1 without a byte-order mark in the
# computer's ANSI code page, so any other character would come out garbled.

function Install-Roost {
  param(
    [switch]$Update,
    [switch]$NoStart,
    [string]$Dir
  )

  # Everything below is set in this function's own scope, so it is undone by itself when the function returns:
  # the window that ran `irm ... | iex` keeps its own error and progress preferences and strict mode.
  Set-StrictMode -Version 2
  $ErrorActionPreference = 'Stop'
  # The progress bar makes Invoke-WebRequest and Expand-Archive many times slower in Windows PowerShell 5.1.
  $ProgressPreference = 'SilentlyContinue'
  # Windows PowerShell 5.1 may not offer TLS 1.2 by default, and GitHub accepts nothing older. Added to what is
  # already allowed, and put back as it was at the end (this one is shared by the whole PowerShell process).
  $oldProtocols = [Net.ServicePointManager]::SecurityProtocol
  try {
    [Net.ServicePointManager]::SecurityProtocol = $oldProtocols -bor [Net.SecurityProtocolType]::Tls12
  } catch { }

  $Repo = 'Just-Rice/roost'
  $TaskPath = '\Roost\'
  $TaskName = 'Roost'
  $RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

  function Say([string]$Text) { if (-not $Update) { Write-Host $Text } }
  # Stops the install with a friendly message: the catch at the bottom prints it.
  function Fail([string]$Text) {
    $e = New-Object System.Exception $Text
    $e.Data['RoostInstall'] = $true
    throw $e
  }
  function Get-HttpStatus($ErrorRecord) {
    try {
      $ex = $ErrorRecord.Exception
      if ($ex.PSObject.Properties['Response'] -and $ex.Response) { return [int]$ex.Response.StatusCode }
    } catch { }
    return 0
  }
  function Get-Web([string]$Url, [string]$OutFile) {
    $headers = @{ 'Accept' = 'application/vnd.github+json' }
    if ($OutFile) {
      # Three tries, as `curl --retry 3` on the Mac.
      for ($try = 1; ; $try++) {
        try {
          Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
          return
        } catch {
          if ($try -ge 3) { throw }
          Start-Sleep -Seconds 2
        }
      }
    }
    return (Invoke-WebRequest -Uri $Url -Headers $headers -UseBasicParsing).Content
  }
  # roost.exe processes started from the install folder. One running as administrator (the scheduled task of
  # "Control admin apps") hides its path from this unelevated PowerShell, so a roost.exe whose path can't be read
  # counts too.
  function Get-RoostProcesses([string]$Folder) {
    $prefix = $Folder.TrimEnd('\') + '\'
    foreach ($p in @(Get-Process -Name roost -ErrorAction SilentlyContinue)) {
      $path = $null
      try { $path = $p.Path } catch { }
      if (-not $path -or $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $p }
    }
  }
  function Wait-RoostExit([string]$Folder, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while (@(Get-RoostProcesses $Folder).Count -gt 0) {
      if ((Get-Date) -ge $deadline) { return $false }
      Start-Sleep -Milliseconds 250
    }
    return $true
  }
  function Test-RoostTask {
    try {
      return [bool](Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue)
    } catch { return $false }
  }

  $work = $null
  $stage = $null
  $global:LASTEXITCODE = 0
  try {
    # 1. This PC.
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { Fail 'Roost runs on Windows only.' }
    $build = 0
    try {
      $build = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
    } catch {
      $build = [Environment]::OSVersion.Version.Build
    }
    if ($build -lt 18362) {
      Fail ("Roost needs Windows 10 version 1903 or later, or Windows 11 (this PC has Windows build $build). " +
        'Newer versions of Windows 10 are a free update in Settings > Update & Security > Windows Update.')
    }
    # x64 or ARM64? Asked of the processor, not of this PowerShell: an x64 PowerShell running under emulation on
    # an ARM64 PC says AMD64 in PROCESSOR_ARCHITECTURE. PROCESSOR_ARCHITEW6432 is set in 32-bit processes on
    # 64-bit Windows; the machine-wide value in the registry and Win32_Processor (12 = ARM64) are never emulated.
    $names = @($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE)
    try {
      $names += (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment').PROCESSOR_ARCHITECTURE
    } catch { }
    $cpuArm = $false
    try {
      $cpuArm = @(Get-CimInstance -ClassName Win32_Processor | Where-Object { $_.Architecture -eq 12 }).Count -gt 0
    } catch { }
    if ($cpuArm -or ($names -contains 'ARM64')) {
      $arch = 'arm64'
    } elseif (($names -contains 'AMD64') -and [Environment]::Is64BitOperatingSystem) {
      $arch = 'x64'
    } else {
      Fail 'Roost needs 64-bit Windows (x64 or ARM64). This PC runs 32-bit Windows, which Roost does not support.'
    }

    # 2. Which release.
    $testApi = $env:ROOST_RELEASES_API
    $api = 'https://api.github.com/repos/' + $Repo + '/releases'
    if ($testApi) { $api = $testApi.TrimEnd('/') }
    $wanted = $env:ROOST_VERSION
    if ($wanted) {
      $wanted = $wanted.TrimStart('v')
      try { $json = Get-Web ($api + '/tags/v' + $wanted) } catch {
        if ((Get-HttpStatus $_) -eq 404) { Fail "couldn't find Roost version $wanted." }
        Fail "couldn't reach GitHub to find Roost $wanted. Check your internet connection and try again."
      }
    } else {
      try { $json = Get-Web ($api + '/latest') } catch {
        $status = Get-HttpStatus $_
        if ($status -eq 403 -or $status -eq 429) {
          Fail 'GitHub is limiting how often it can be asked from this network. Try again in an hour.'
        }
        Fail "couldn't reach GitHub to find the latest Roost. Check your internet connection and try again."
      }
    }
    try { $release = $json | ConvertFrom-Json } catch { Fail "GitHub's answer didn't make sense. Try again later." }

    $tag = ''
    if ($release.PSObject.Properties['tag_name'] -and $release.tag_name) { $tag = [string]$release.tag_name }
    $urls = @()
    if ($release.PSObject.Properties['assets']) {
      foreach ($a in @($release.assets)) {
        if ($a -and $a.PSObject.Properties['browser_download_url']) { $urls += [string]$a.browser_download_url }
      }
    }
    # Downloads must come over https; only a test pointing ROOST_RELEASES_API at a local server may use plain http.
    $scheme = 'https:'
    if ($testApi) { $scheme = 'https?:' }
    # x.y.z, or x.y.z-alpha.N (beta, rc) for a test build asked for by ROOST_VERSION. Spelled out, and the
    # processor named in full, so the x64 file can never pass for the ARM64 one or the other way round.
    $verRe = '[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?'
    $zipRe = '^' + $scheme + '//\S*/(Roost-(' + $verRe + ')-win-' + $arch + '\.zip)$'
    $sumRe = '^' + $scheme + '//\S*/Roost-' + $verRe + '-win-' + $arch + '\.zip\.sha256$'
    $zipUrl = $null; $sumUrl = $null; $zipName = $null; $version = $null
    foreach ($u in $urls) {
      if (-not $zipUrl -and $u -match $zipRe) { $zipUrl = $u; $zipName = $Matches[1]; $version = $Matches[2] }
      elseif (-not $sumUrl -and $u -match $sumRe) { $sumUrl = $u }
    }
    if ($tag -and -not $zipUrl -and $arch -eq 'arm64') {
      Fail ('Roost ' + $tag.TrimStart('v') + ' has no version for ARM64 PCs yet.')
    }
    if (-not $tag -or -not $zipUrl -or -not $sumUrl) {
      Fail "the latest release doesn't have the files this installer expects."
    }
    Say "Installing Roost $version for $arch..."

    # 3. Download and check.
    $work = Join-Path ([IO.Path]::GetTempPath()) ('roost-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $zip = Join-Path $work $zipName
    $sum = $zip + '.sha256'
    try { Get-Web $zipUrl $zip } catch { Fail "the download didn't finish. Try again." }
    try { Get-Web $sumUrl $sum } catch { Fail "couldn't download the checksum." }
    # The .sha256 file is shasum's output: "<hex>  <file name>".
    $expected = ''
    $sumText = [string](Get-Content -LiteralPath $sum -Raw)
    $tokens = @(-split $sumText)
    if ($tokens.Count -gt 0) { $expected = $tokens[0] }
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
    # -eq on strings ignores case: shasum writes lowercase, Get-FileHash uppercase.
    if ($expected -notmatch '^[0-9A-Fa-f]{64}$' -or $expected -ne $actual) {
      Fail "the download doesn't match its checksum, so it was not installed. Try again later."
    }

    # 4. Where it goes, and unpack next to it (same drive, so the swap below is a rename, not a copy).
    if (-not $env:LOCALAPPDATA) { Fail "this account has no local AppData folder (%LOCALAPPDATA% isn't set)." }
    if ($Dir) {
      $dest = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Dir)
    } else {
      $dest = Join-Path $env:LOCALAPPDATA 'Programs\Roost'
    }
    $dest = [IO.Path]::GetFullPath($dest).TrimEnd('\')
    $parent = Split-Path -Parent $dest
    if (-not $parent) { Fail "$dest is a whole drive. Choose a folder for Roost instead." }
    # Never throw away a folder that holds something else: -Dir must name a new, empty or earlier Roost folder.
    if ((Test-Path -LiteralPath $dest) -and -not (Test-Path -LiteralPath (Join-Path $dest 'roost.exe')) -and
        @(Get-ChildItem -LiteralPath $dest -Force).Count -gt 0) {
      Fail "$dest already has other files in it. Choose an empty folder for Roost."
    }
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $stage = $dest + '.new'
    $old = $dest + '.old'
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    try { Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force } catch {
      Fail "couldn't unpack the download into $parent."
    }
    # The zip may hold the files themselves or one folder with them in it.
    $root = $stage
    $top = @(Get-ChildItem -LiteralPath $stage -Force)
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'roost.exe')) -and $top.Count -eq 1 -and $top[0].PSIsContainer) {
      $root = $top[0].FullName
    }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'roost.exe'))) {
      Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
      Fail "the download doesn't contain roost.exe."
    }
    $versionFile = Join-Path $root 'VERSION'
    if (Test-Path -LiteralPath $versionFile) {
      $inside = ([string](Get-Content -LiteralPath $versionFile -Raw)).Trim()
      if ($inside -ne $version) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        Fail "the download says it is Roost $inside, not $version, so it was not installed."
      }
    }
    # Belt and braces: make sure nothing in it is marked as downloaded, so SmartScreen leaves it alone.
    try { Get-ChildItem -LiteralPath $root -Recurse -File | Unblock-File } catch { }

    # 5. Close the running Roost. With -Update, Roost started this installer and is quitting by itself, so give it
    # time; otherwise there is no polite way to ask a tray app, so it is closed after a moment.
    $wasRunning = @(Get-RoostProcesses $dest).Count -gt 0
    if ($wasRunning) {
      Say 'Closing the running Roost...'
      $grace = 3
      if ($Update) { $grace = 30 }
      if (-not (Wait-RoostExit $dest $grace)) {
        foreach ($p in @(Get-RoostProcesses $dest)) {
          try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
        }
        if (-not (Wait-RoostExit $dest 5)) {
          Fail ("couldn't close the running Roost (with 'Control admin apps' on it runs as administrator). " +
            'Quit it from its tray icon, then try again.')
        }
      }
    }

    # Swap: the old copy steps aside, the new one moves in, and the old one goes back if that fails.
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $old) { Fail "couldn't remove $old, left from an earlier install. Delete it, then try again." }
    if (Test-Path -LiteralPath $dest) {
      try { Move-Item -LiteralPath $dest -Destination $old } catch {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        Fail "couldn't replace $dest. Is a file in it still open? Close Roost, then try again."
      }
    }
    try {
      Move-Item -LiteralPath $root -Destination $dest
    } catch {
      if ((Test-Path -LiteralPath $old) -and -not (Test-Path -LiteralPath $dest)) {
        Move-Item -LiteralPath $old -Destination $dest -ErrorAction SilentlyContinue
      }
      Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
      Fail "couldn't put Roost in $dest."
    }
    Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    $exe = Join-Path $dest 'roost.exe'

    # 6. Start with Windows. With "Control admin apps" on, the scheduled task \Roost\Roost does that (as
    # administrator), and a Run key entry as well would start a second, unelevated copy. An update only refreshes
    # an entry that is there (the folder may have moved), so turning "start with Windows" off in Roost sticks.
    $hasTask = Test-RoostTask
    if (-not $hasTask) {
      $hasRunValue = $false
      if (Test-Path $RunKey) {
        $hasRunValue = [bool]((Get-Item $RunKey).GetValue('Roost', $null))
      } else {
        New-Item -Path $RunKey -Force | Out-Null
      }
      if (-not $Update -or $hasRunValue) {
        Set-ItemProperty -Path $RunKey -Name 'Roost' -Value ('"' + $exe + '" --startup')
      }
    }

    # 7. Start it. --startup starts it quietly in the tray; without it Roost opens its Control Center.
    if (-not $NoStart) {
      $started = $false
      if ($hasTask) {
        # Through its task, so it runs as administrator again, as it did before (no UAC prompt: the task was
        # approved once, when "Control admin apps" was turned on).
        try { Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName; $started = $true } catch { }
      }
      if (-not $started) {
        if ($Update) {
          Start-Process -FilePath $exe -ArgumentList '--startup' -WorkingDirectory $dest
        } else {
          Start-Process -FilePath $exe -WorkingDirectory $dest
        }
      }
    }
    Say "Roost $version is installed in $dest."
    if ($NoStart) {
    } elseif ($hasTask) {
      Say "It's starting now: look for its icon in the taskbar's notification area."
    } else {
      Say "It's starting now and will open its Control Center in your browser."
    }
  } catch {
    $global:LASTEXITCODE = 1
    $ex = $_.Exception
    Write-Host ('Roost install failed: ' + $ex.Message) -ForegroundColor Red
    if (-not $ex.Data.Contains('RoostInstall')) {
      # Something this script didn't plan for: say where, so a report of it can be acted on.
      Write-Host ('(' + $_.InvocationInfo.PositionMessage + ')') -ForegroundColor Red
    }
  } finally {
    # The unpacked copy, if the install stopped before it moved in (it is next to the install folder, not in Temp).
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    if ($work -and (Test-Path -LiteralPath $work)) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    try { [Net.ServicePointManager]::SecurityProtocol = $oldProtocols } catch { }
  }
}

# Run it. $args carries the options when this file is run with -File or as a script block; piped into iex there are
# none. Only a script run with -File sets the exit code of powershell.exe: `exit` in a window running iex would
# close that window.
if (Test-Path Variable:\args) { Install-Roost @args } else { Install-Roost }
if ($global:LASTEXITCODE -ne 0 -and $MyInvocation.MyCommand.CommandType -eq 'ExternalScript') { exit $global:LASTEXITCODE }

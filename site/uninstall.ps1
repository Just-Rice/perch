# Removes Roost from this PC.
#
#   irm https://just-rice.github.io/roost/uninstall.ps1 | iex
#
# What it does, in order:
#   1. closes Roost if it's running from its install folder;
#   2. stops it starting with Windows: removes the "Roost" value from the HKCU Run key, and the scheduled task
#      \Roost\Roost that "Control admin apps" uses (that task runs as administrator, so Windows may only let an
#      administrator remove it: if so, this says how);
#   3. deletes the app, %LOCALAPPDATA%\Programs\Roost;
#   4. asks before deleting your settings, pairings and log, %LOCALAPPDATA%\Roost (config.json, secrets.dpapi,
#      roost.log). Keep them and a later install of Roost picks up where this one left off.
#
# Your paired devices stop working with this PC. Their passkeys stay in the password manager of each device (and
# Roost's entry in your authenticator app, if you added one) until you delete them there.
# Never needs administrator rights, except for removing that one scheduled task. Uses only built-in cmdlets.
#
# Options: -KeepData (keep %LOCALAPPDATA%\Roost without asking), -Yes (delete it without asking), -Dir <folder>
# (Roost was installed with install.ps1 -Dir). To pass them, run it as a script block:
#
#   & ([scriptblock]::Create((irm https://just-rice.github.io/roost/uninstall.ps1))) -Yes
#
# This file is plain ASCII on purpose: Windows PowerShell 5.1 reads a .ps1 without a byte-order mark in the
# computer's ANSI code page, so any other character would come out garbled.

function Uninstall-Roost {
  param(
    [switch]$KeepData,
    [switch]$Yes,
    [string]$Dir
  )

  # Set in this function's own scope only: the window that ran `irm ... | iex` keeps its own preferences.
  Set-StrictMode -Version 2
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $TaskPath = '\Roost\'
  $TaskName = 'Roost'
  $RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

  function Say([string]$Text) { Write-Host $Text }
  function Warn([string]$Text) { Write-Host $Text -ForegroundColor Yellow }
  function Fail([string]$Text) {
    $e = New-Object System.Exception $Text
    $e.Data['RoostUninstall'] = $true
    throw $e
  }
  # roost.exe processes started from the install folder (or whose path can't be read: one running as
  # administrator hides it from an unelevated PowerShell).
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
  function Remove-Folder([string]$Path) {
    # A few tries: Windows can hold on to a file for a moment after the process that had it open has exited.
    for ($try = 1; $try -le 5; $try++) {
      try { Remove-Item -LiteralPath $Path -Recurse -Force; return $true } catch { Start-Sleep -Seconds 1 }
      if (-not (Test-Path -LiteralPath $Path)) { return $true }
    }
    return $false
  }

  $global:LASTEXITCODE = 0
  $problems = 0
  try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { Fail 'this is for Windows; Roost runs on Windows only.' }
    if (-not $env:LOCALAPPDATA) { Fail "this account has no local AppData folder (%LOCALAPPDATA% isn't set)." }
    if ($Dir) {
      $dest = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Dir)
    } else {
      $dest = Join-Path $env:LOCALAPPDATA 'Programs\Roost'
    }
    $dest = [IO.Path]::GetFullPath($dest).TrimEnd('\')
    $data = Join-Path $env:LOCALAPPDATA 'Roost'
    # Never delete a folder that isn't Roost's: it must have roost.exe in it.
    $isRoostDir = Test-Path -LiteralPath (Join-Path $dest 'roost.exe')
    if ((Test-Path -LiteralPath $dest) -and -not $isRoostDir -and @(Get-ChildItem -LiteralPath $dest -Force).Count -gt 0) {
      Fail "$dest doesn't look like Roost's folder (there is no roost.exe in it), so nothing was deleted."
    }

    # 1. Close it.
    if (@(Get-RoostProcesses $dest).Count -gt 0) {
      Say 'Closing Roost...'
      foreach ($p in @(Get-RoostProcesses $dest)) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
      }
      if (-not (Wait-RoostExit $dest 5)) {
        Warn "Couldn't close Roost: it runs as administrator. Quit it from its tray icon, then run this again."
        $problems++
      }
    }

    # 2. Stop it starting with Windows.
    if (Test-Path $RunKey) {
      $runValue = (Get-Item $RunKey).GetValue('Roost', $null)
      if ($null -ne $runValue) {
        try { Remove-ItemProperty -Path $RunKey -Name 'Roost' } catch {
          Warn "Couldn't remove Roost from the programs that start with Windows ($($_.Exception.Message))."
          $problems++
        }
      }
    }
    $task = $null
    try { $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
    if ($task) {
      try {
        Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Confirm:$false
      } catch {
        Warn "Windows only lets an administrator remove Roost's 'Control admin apps' task. To remove it, open"
        Warn 'PowerShell or Command Prompt with "Run as administrator" and run:'
        Warn ''
        Warn '    schtasks /Delete /TN "\Roost\Roost" /F'
        Warn ''
        $problems++
      }
    }

    # 3. The app.
    if (Test-Path -LiteralPath $dest) {
      if (Remove-Folder $dest) {
        Say "Deleted $dest."
      } else {
        Warn "Couldn't delete $dest (is Roost still running?). Close Roost, then delete that folder."
        $problems++
      }
    }
    foreach ($leftover in @(($dest + '.old'), ($dest + '.new'))) {
      if (Test-Path -LiteralPath $leftover) { Remove-Folder $leftover | Out-Null }
    }

    # 4. Settings, pairings and log.
    if (Test-Path -LiteralPath $data) {
      $delete = $false
      if ($KeepData) {
        $delete = $false
      } elseif ($Yes) {
        $delete = $true
      } else {
        Say "Roost's settings, pairings and log are in $data."
        $answer = ''
        try { $answer = Read-Host 'Delete them too? Keep them and reinstalling Roost picks up where you left off. [y/N]' } catch { }
        $delete = ([string]$answer).Trim() -match '^(y|yes)$'
      }
      if ($delete) {
        if (Remove-Folder $data) {
          Say "Deleted Roost's settings, pairings and log."
        } else {
          Warn "Couldn't delete $data. Close Roost, then delete that folder."
          $problems++
        }
      } else {
        Say "Kept Roost's settings, pairings and log in $data."
      }
    }

    if ($problems -gt 0) {
      $global:LASTEXITCODE = 1
      Warn 'Roost is mostly uninstalled: see above for what is left to do.'
    } else {
      Say 'Roost is uninstalled.'
    }
    Say 'To finish, delete the Roost passkeys on your other devices (in their password settings) and remove Roost'
    Say 'from your authenticator app, if you added it there.'
  } catch {
    $global:LASTEXITCODE = 1
    $ex = $_.Exception
    Write-Host ('Roost uninstall failed: ' + $ex.Message) -ForegroundColor Red
    if (-not $ex.Data.Contains('RoostUninstall')) {
      Write-Host ('(' + $_.InvocationInfo.PositionMessage + ')') -ForegroundColor Red
    }
  }
}

# Run it. $args carries the options when this file is run with -File or as a script block; piped into iex there are
# none. Only a script run with -File sets the exit code of powershell.exe: `exit` in a window running iex would
# close that window.
if (Test-Path Variable:\args) { Uninstall-Roost @args } else { Uninstall-Roost }
if ($global:LASTEXITCODE -ne 0 -and $MyInvocation.MyCommand.CommandType -eq 'ExternalScript') { exit $global:LASTEXITCODE }

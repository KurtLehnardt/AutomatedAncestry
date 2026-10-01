# AutomatedAncestry -- one-shot Windows installer.
#
#   irm https://raw.githubusercontent.com/KurtLehnardt/AutomatedAncestry/main/install-windows.ps1 | iex
#
# Installs Node.js 24.16+ and git if missing (winget if available, otherwise a
# direct official-installer download), clones the repo, then runs the guided
# setup: Ollama, a model sized for this PC, and OpenClaw. Safe to re-run.

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 (still the default on many machines, including every
# Windows Server image) defaults its underlying .NET stack to TLS 1.0/1.1,
# which GitHub and nodejs.org both reject -- Invoke-WebRequest fails with a
# generic "connection was closed unexpectedly" that gives no hint why. Force
# TLS 1.2 before any web request.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoUrl = "https://github.com/KurtLehnardt/AutomatedAncestry.git"
$TargetDir = if ($env:AUTOMATED_ANCESTRY_DIR) { $env:AUTOMATED_ANCESTRY_DIR } else { "AutomatedAncestry" }
$NodeMajorMin = 24
$NodeMinorMin = 16

function Log($msg)  { Write-Host "`n$msg" -ForegroundColor White }
function Ok($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "  [x] $msg" -ForegroundColor Red; exit 1 }

function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function HaveWinget() { return (Have "winget") }

# $ErrorActionPreference = "Stop" only promotes PowerShell cmdlet errors to
# terminating ones -- it does NOT make a native command's nonzero exit code
# throw (unlike bash's `set -e`, which install-linux.sh relies on for the
# same calls). Every native command that can fail is checked explicitly here.
function Assert-LastExitCode($msg) {
  if ($LASTEXITCODE -ne 0) { Die $msg }
}

$script:IsElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)

Log "AutomatedAncestry -- Windows install"

# Refresh PATH in this process so a package we just installed is visible
# without needing a new shell (installers update the registry, not our PATH).
# Merges into the existing $env:Path rather than replacing it, so anything
# the calling session had that isn't persisted to Machine/User scope survives.
function Sync-Path {
  $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$env:Path;$machine;$user"
}

# The installer's own process can exit slightly before its registry PATH
# write (or a deferred/spawned step) lands, especially under disk/AV
# contention -- poll briefly instead of judging success from one snapshot.
function Wait-Have($cmd, $timeoutSeconds = 15) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  do {
    Sync-Path
    if (Have $cmd) { return $true }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  return $false
}

if (HaveWinget) {
  Ok "winget available"
} else {
  Warn "winget not found (common on Windows Server / locked-down images) -- falling back to direct installer downloads"
  if (-not $script:IsElevated) {
    Warn "Not running as Administrator. git's fallback installs per-user (no admin needed), but Node's official .msi is machine-scoped and its install will fail without elevation. If the Node step below fails, re-open PowerShell as Administrator and re-run."
  }
}

# 1) git.
if (Have "git") {
  Ok "git already installed ($(git --version))"
} else {
  Log "Installing git..."
  if (HaveWinget) {
    winget install -e --id Git.Git --silent --accept-package-agreements --accept-source-agreements
  } else {
    # Ask GitHub for the actual latest release rather than hardcoding a
    # version+build pin -- git-for-windows' build number doesn't track its
    # version number 1:1 (e.g. 2.47.1 shipped as build 2.47.1.2), so any pin
    # goes stale (and silently 404s) the moment a new release ships.
    $gitRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/git-for-windows/git/releases/latest" -Headers @{ "User-Agent" = "automated-ancestry-install-script" }
    $gitAsset = $gitRelease.assets | Where-Object { $_.name -match '^Git-.*-64-bit\.exe$' } | Select-Object -First 1
    if (-not $gitAsset) { Die "couldn't find a 64-bit installer in the latest git-for-windows release ($($gitRelease.tag_name))." }
    $gitUrl = $gitAsset.browser_download_url
    $gitInstaller = "$env:TEMP\git-installer.exe"
    Log "Downloading Git for Windows ($($gitRelease.tag_name))..."
    Invoke-WebRequest -Uri $gitUrl -OutFile $gitInstaller -UseBasicParsing
    Log "Running installer silently..."
    # /CURRENTUSER installs per-user -- unlike Node's .msi below, git-for-
    # windows' Inno Setup installer supports this, so it works without
    # Administrator rights regardless of $script:IsElevated.
    Start-Process -FilePath $gitInstaller -ArgumentList "/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-", "/CURRENTUSER" -Wait
    Remove-Item $gitInstaller -ErrorAction SilentlyContinue
  }
  if (-not (Wait-Have "git")) { Die "git install finished but 'git' still isn't on PATH -- open a new shell and re-run." }
  Ok "git installed ($(git --version))"
}

# 2) Node.js 24.16+ (OpenClaw's floor).
$nodeOk = $false
if (Have "node") {
  $nodeVersionRaw = (node -v)
  if ($nodeVersionRaw -match '^v(\d+)\.') {
    $nodeMajor = [int]$Matches[1]
    $nodeMinor = [int]($nodeVersionRaw -replace '^v\d+\.(\d+).*','$1')
    if ($nodeMajor -gt $NodeMajorMin -or ($nodeMajor -eq $NodeMajorMin -and $nodeMinor -ge $NodeMinorMin)) {
      Ok "node already installed ($nodeVersionRaw)"
      $nodeOk = $true
    } else {
      Warn "node $nodeVersionRaw is older than $NodeMajorMin.$NodeMinorMin -- installing a newer one"
    }
  } else {
    Warn "couldn't parse a version from 'node -v' ($nodeVersionRaw) -- installing $NodeMajorMin to be safe"
  }
}
if (-not $nodeOk) {
  Log "Installing Node.js $NodeMajorMin..."
  if (HaveWinget) {
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  } else {
    # nodejs.org's index.json is sorted newest-first; take the latest v24.x
    # release rather than pinning one, for the same reason as the git lookup
    # above -- a pinned version goes stale.
    $nodeRelease = (Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json") | Where-Object { $_.version -match "^v$NodeMajorMin\." } | Select-Object -First 1
    if (-not $nodeRelease) { Die "couldn't find a v$NodeMajorMin release in nodejs.org's release index." }
    $nodeUrl = "https://nodejs.org/dist/$($nodeRelease.version)/node-$($nodeRelease.version)-x64.msi"
    $nodeInstaller = "$env:TEMP\node-installer.msi"
    Log "Downloading Node.js ($($nodeRelease.version))..."
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeInstaller -UseBasicParsing
    Log "Running installer silently..."
    Start-Process -FilePath "msiexec.exe" -ArgumentList "/i", "`"$nodeInstaller`"", "/qn", "/norestart" -Wait
    Remove-Item $nodeInstaller -ErrorAction SilentlyContinue
  }
  if (-not (Wait-Have "node")) {
    $hint = if (-not $script:IsElevated) { " This is likely the earlier elevation warning -- re-run as Administrator." } else { " Open a new shell and re-run." }
    Die "node install finished but 'node' still isn't on PATH.$hint"
  }
  Ok "node installed ($(node -v))"
}

# 3) Clone (skip if already present). Checked via scripts\setup.mjs, not a
# bare .git dir -- a clone interrupted mid-checkout leaves .git present but no
# working tree, which would otherwise make a re-run skip straight to a `cd`
# that doesn't exist yet. If $TargetDir exists but isn't a finished clone,
# `git clone` below fails with its own clear error rather than this script
# guessing whether it's safe to delete.
if (Test-Path "$TargetDir\scripts\setup.mjs") {
  Ok "$TargetDir already cloned"
} else {
  Log "Cloning $RepoUrl into .\$TargetDir ..."
  git clone $RepoUrl $TargetDir
  Assert-LastExitCode "git clone failed. If $TargetDir was partially created, remove it before re-running."
  Ok "cloned"
}

# 4) Hand off to the guided setup (Ollama + model + OpenClaw).
Set-Location $TargetDir
Log "Starting guided setup..."
node scripts\setup.mjs @args
exit $LASTEXITCODE

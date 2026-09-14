# Wrapper invoked by Task Scheduler.
# The scheduler guarantees neither PATH nor working directory, so resolve both here.
#
# NOTE: keep every string literal in this file ASCII-only. Windows PowerShell 5.1
# reads BOM-less .ps1 files as ANSI, which mangles non-ASCII literals. Korean
# output comes from digest.ts (UTF-8) and is unaffected.
param([switch]$DryRun, [switch]$Check, [switch]$Collect, [switch]$Poll, [switch]$WhoAmI)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# PowerShell decodes a native exe's stdout using [Console]::OutputEncoding. Under
# Task Scheduler that is the ANSI codepage, which mangles digest.ts's UTF-8 Korean
# output in the log. Setting it here fixes scheduled runs. It can throw when no
# console is attached, hence the guard.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) {
  $bun = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter bun.exe -ErrorAction SilentlyContinue |
         Select-Object -First 1 -ExpandProperty FullName
}
if (-not $bun) { throw "bun not found. Install with: winget install Oven-sh.Bun" }

# The claude CLI may not be on PATH under the scheduler either.
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}

# Polling only has anything to do while a draft awaits approval, which is a few
# hours a week. Skipping the rest turns ~288 runs/day into ~0. digest.ts flushes
# the queued messages when it drafts, so nothing stale gets applied later.
if ($Poll -and -not (Test-Path (Join-Path $root 'pending.json'))) { exit 0 }

$args = @()
if ($DryRun)  { $args += '--dry-run' }
if ($Check)   { $args += '--check' }
if ($Collect) { $args += '--collect' }
if ($Poll)    { $args += '--poll' }
if ($WhoAmI)  { $args += '--whoami' }

# One log per mode. Collect (2h) and Poll (5min) would otherwise interleave with
# Draft in a single file, and concurrent Add-Content from two tasks can corrupt lines.
$mode = if ($Collect) { 'collect' } elseif ($Poll) { 'poll' } elseif ($Check) { 'check' }
        elseif ($WhoAmI) { 'whoami' } elseif ($DryRun) { 'dryrun' } else { 'draft' }
$log = Join-Path $root "run-$mode.log"
"=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') run start ===" | Add-Content -Path $log -Encoding utf8

# Native stderr must not abort us: under 'Stop', PowerShell 5.1 wraps each stderr
# line from an exe in an ErrorRecord and treats it as terminating. Flattening each
# record with "$_" also strips the NativeCommandError noise from the log.
$ErrorActionPreference = 'Continue'
$output = & $bun run (Join-Path $root 'digest.ts') @args 2>&1 | ForEach-Object { "$_" }
$exit = $LASTEXITCODE

$output | ForEach-Object { Write-Host $_ }
$output | Add-Content -Path $log -Encoding utf8

if ($exit -ne 0) {
  "!!! FAILED (exit $exit)" | Add-Content -Path $log -Encoding utf8
  exit $exit
}

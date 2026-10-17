param(
  [ValidateSet('package', 'smoke', 'probe')][string]$Stage,
  [switch]$Child,
  [switch]$Restrict,
  [string]$Receipt,
  [string]$NodeExecutable
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo
$diagnostics = Join-Path $PSScriptRoot 'validation'
New-Item -ItemType Directory -Path $diagnostics -Force | Out-Null
if (!$NodeExecutable) { $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (!$Receipt) { $Receipt = Join-Path $diagnostics ("windows-smoke-ci-$Stage-" + [guid]::NewGuid().ToString('N') + '.json') }
$stdout = "$Receipt.stdout.log"
$stderr = "$Receipt.stderr.log"
$logOffsets = @{}
function Write-NewValidationLogs {
  foreach ($log in @($stdout, $stderr)) {
    if (!(Test-Path -LiteralPath $log)) { continue }
    try {
      $stream = [IO.File]::Open($log, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
      try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } catch { continue }
    $offset = if ($logOffsets.ContainsKey($log)) { $logOffsets[$log] } else { 0 }
    if ($content.Length -gt $offset) { Write-Host -NoNewline $content.Substring($offset); $logOffsets[$log] = $content.Length }
  }
}

if (!$Child -and ($isAdministrator -or $Restrict)) {
  # PostgreSQL correctly refuses an elevated token. Keep the same user/profile
  # and disable administrator membership for these ordinary desktop checks.
  function Quote-Literal([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
  if ($isAdministrator -and $env:GITHUB_ACTIONS -eq 'true') {
    # D:\a can grant writes only through Administrators. Add the existing
    # runner user's SID explicitly so the restricted child can write its checkout.
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $accessMarker = Join-Path $diagnostics 'windows-ci-access.txt'
    # The early probe runs before dependency installation. Later files inherit
    # this grant; walking the installed workspace again is both slow and redundant.
    if (!(Test-Path -LiteralPath $accessMarker) -or [IO.File]::ReadAllText($accessMarker).Trim() -ne $userSid) {
      & icacls.exe $repo /grant "*${userSid}:(OI)(CI)M" /T /Q | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Could not grant the runner user access to its checkout' }
      [IO.File]::WriteAllText($accessMarker, $userSid)
    }
  }
  $command = '$env:SI_VERSION=' + (Quote-Literal $env:SI_VERSION) + '; & ' + (Quote-Literal $PSCommandPath) + ' -Child -Stage ' + $Stage + ' -Receipt ' + (Quote-Literal $Receipt) + ' -NodeExecutable ' + (Quote-Literal $NodeExecutable)
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-ci-token.cs')
  if ($isAdministrator -and $env:GITHUB_ACTIONS -eq 'true') { [SiWindowsCiToken]::GrantDesktopAccess() }
  $childPid = [SiWindowsCiToken]::Start($powershell, ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded), $repo)
  Write-Host "Started restricted validation process $childPid"
  $deadline = (Get-Date).AddMinutes(30)
  while (!(Test-Path -LiteralPath $Receipt)) {
    Write-NewValidationLogs
    if ((Get-Date) -gt $deadline) { throw 'Ordinary-user validation timed out' }
    $childExitCode = [SiWindowsCiToken]::ExitCode()
    if ($childExitCode -ne 259 -and !(Test-Path -LiteralPath $Receipt)) { throw ('Validation process exited without a receipt: 0x{0:X8}' -f $childExitCode) }
    Start-Sleep -Seconds 1
  }
  $result = Get-Content -LiteralPath $Receipt -Raw | ConvertFrom-Json
  [SiWindowsCiToken]::Close()
} else {
  $code = 1
  try {
    if ($isAdministrator) { throw 'Validation is still elevated; refusing to weaken PostgreSQL checks' }
    Write-Host "Running $Stage validation without administrator membership"
    if ($Stage -eq 'probe') { $arguments = '--version' }
    else {
      $script = if ($Stage -eq 'package') { 'package-windows.mjs' } else { 'windows-smoke.mjs' }
      $arguments = '"' + (Join-Path $PSScriptRoot $script) + '"'
    }
    $process = Start-Process -FilePath $NodeExecutable -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $null = $process.Handle
    # Start-Process -Wait also waits for detached descendants. The Node checker
    # owns backend cleanup; preserve its result and wait for that process only.
    $process.WaitForExit()
    $process.Refresh()
    if ($null -eq $process.ExitCode) { throw 'Checker exit code was not available' }
    $code = [int]$process.ExitCode
  } catch {
    $_ | Out-String | Set-Content -LiteralPath $stderr -Encoding UTF8
  } finally {
    $result = @{ exitCode = $code; administrator = $isAdministrator; stage = $Stage }
    $result | ConvertTo-Json | Set-Content -LiteralPath "$Receipt.staged" -Encoding UTF8
    Move-Item -LiteralPath "$Receipt.staged" -Destination $Receipt -Force
  }
}
Write-NewValidationLogs
if ($result.administrator) { throw 'Expected an ordinary-user token' }
if ($null -eq $result.exitCode) { throw 'Validation did not report an exit code' }
exit $result.exitCode

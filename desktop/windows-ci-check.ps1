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

if (!$Child -and ($isAdministrator -or $Restrict)) {
  # PostgreSQL correctly refuses an elevated token. Keep the same user/profile
  # and disable administrator membership for these ordinary desktop checks.
  function Quote-Literal([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
  if ($isAdministrator -and $env:GITHUB_ACTIONS -eq 'true') {
    # D:\a can grant writes only through Administrators. Add the existing
    # runner user's SID explicitly so the restricted child can write its checkout.
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $repo /grant "*${userSid}:(OI)(CI)M" /T /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant the runner user access to its checkout' }
  }
  $command = '$env:SI_VERSION=' + (Quote-Literal $env:SI_VERSION) + '; & ' + (Quote-Literal $PSCommandPath) + ' -Child -Stage ' + $Stage + ' -Receipt ' + (Quote-Literal $Receipt) + ' -NodeExecutable ' + (Quote-Literal $NodeExecutable)
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-ci-token.cs')
  $childPid = [SiWindowsCiToken]::Start($powershell, ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded), $repo)
  Write-Host "Started restricted validation process $childPid"
  $deadline = (Get-Date).AddMinutes(30)
  while (!(Test-Path -LiteralPath $Receipt)) {
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
    $process = Start-Process -FilePath $NodeExecutable -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -Wait -PassThru
    $code = $process.ExitCode
  } catch {
    $_ | Out-String | Set-Content -LiteralPath $stderr -Encoding UTF8
  } finally {
    $result = @{ exitCode = $code; administrator = $isAdministrator; stage = $Stage }
    $result | ConvertTo-Json | Set-Content -LiteralPath "$Receipt.staged" -Encoding UTF8
    Move-Item -LiteralPath "$Receipt.staged" -Destination $Receipt -Force
  }
}
foreach ($log in @($stdout, $stderr)) { if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log | Write-Host } }
if ($result.administrator) { throw 'Expected an ordinary-user token' }
exit $result.exitCode

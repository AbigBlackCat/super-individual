param(
  [ValidateSet('package', 'smoke', 'probe')][string]$Stage,
  [switch]$Child,
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

if (!$Child -and $isAdministrator) {
  # PostgreSQL correctly refuses an elevated token. Keep the same user/profile
  # and disable administrator membership for these ordinary desktop checks.
  function Quote-Literal([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
  $command = '$env:SI_VERSION=' + (Quote-Literal $env:SI_VERSION) + '; & ' + (Quote-Literal $PSCommandPath) + ' -Child -Stage ' + $Stage + ' -Receipt ' + (Quote-Literal $Receipt) + ' -NodeExecutable ' + (Quote-Literal $NodeExecutable)
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $program = '"' + $powershell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded
  & (Join-Path $env:SystemRoot 'System32\runas.exe') /env /trustlevel:0x20000 $program
  if ($LASTEXITCODE -ne 0) { throw 'Could not start ordinary-user validation' }
  $deadline = (Get-Date).AddMinutes(30)
  while (!(Test-Path -LiteralPath $Receipt)) {
    if ((Get-Date) -gt $deadline) { throw 'Ordinary-user validation timed out' }
    Start-Sleep -Seconds 1
  }
  $result = Get-Content -LiteralPath $Receipt -Raw | ConvertFrom-Json
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

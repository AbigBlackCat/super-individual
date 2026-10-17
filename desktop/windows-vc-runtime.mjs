import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const required = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
const powershellEnvironment = () => ({ ...process.env, PSModulePath: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') });
export async function bundleWindowsVcRuntime(destinations) {
  let directory = process.env.SI_VC_RUNTIME_DIRECTORY;
  if (directory && !path.isAbsolute(directory)) throw new Error('SI_VC_RUNTIME_DIRECTORY must be absolute');
  if (!directory) {
    const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe');
    const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
    if (!installation) throw new Error('Install licensed Visual Studio C++ Build Tools, or set SI_VC_RUNTIME_DIRECTORY to its x64 CRT redistributable directory');
    const redist = path.join(installation, 'VC/Redist/MSVC');
    const versions = (await fs.readdir(redist)).filter(name => /^14\.\d+\.\d+$/.test(name)).sort((a,b) => b.localeCompare(a, 'en', { numeric: true }));
    for (const version of versions) {
      const x64 = path.join(redist, version, 'x64');
      const crt = (await fs.readdir(x64).catch(() => [])).find(name => /^Microsoft\.VC\d+\.CRT$/.test(name));
      if (crt) { directory = path.join(x64, crt); break; }
    }
  }
  if (!directory) throw new Error('No x64 Microsoft CRT redistributable found');
  const files = (await fs.readdir(directory)).filter(name => /^(?:concrt140|msvcp140(?:_\w+)?|vccorlib140|vcruntime140(?:_\w+)?)\.dll$/i.test(name));
  if (!required.every(name => files.some(file => file.toLowerCase() === name))) throw new Error('Incomplete x64 Microsoft CRT redistributable');
  // Copy only original, signed redistributable DLLs, never System32 or debug CRTs.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Get-ChildItem -LiteralPath $env:SI_VC_AUDIT_DIRECTORY -Filter '*.dll' | ForEach-Object { $s=Get-AuthenticodeSignature -LiteralPath $_.FullName; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw ('Invalid Microsoft runtime signature: '+$_.Name) } }"], { env: { ...powershellEnvironment(), SI_VC_AUDIT_DIRECTORY: directory }, encoding:'utf8', windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  const manifest = [];
  for (const name of files) {
    const bytes = await fs.readFile(path.join(directory, name));
    const pe = bytes.readUInt32LE(0x3c);
    if (bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error('Microsoft CRT must be x64: ' + name);
    manifest.push({ name, sha256: createHash('sha256').update(bytes).digest('hex'), microsoftSignatureVerified: true });
    for (const destination of destinations) {
      await fs.mkdir(destination, { recursive: true });
      const target = path.join(destination, name);
      await fs.writeFile(target + '.staged', bytes); await fs.rename(target + '.staged', target);
    }
  }
  console.log(`Bundled ${files.length} signed Microsoft x64 CRT redistributable DLLs`);
  return manifest;
}

export async function assertWindowsVcRuntimeLoaded(pid, nativeDirectory) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid PostgreSQL PID');
  const command = `[Console]::OutputEncoding = New-Object Text.UTF8Encoding; Get-Process -Id ${pid} -Module | Where-Object { $_.ModuleName -in @('msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll') } | Select-Object ModuleName,FileName | ConvertTo-Json -Compress`;
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',command], { env:powershellEnvironment(), encoding:'utf8', windowsHide:true }));
  const loaded = Array.isArray(result) ? result : [result];
  const expected = (await fs.realpath(nativeDirectory)).toLowerCase();
  for (const name of required) {
    const module = loaded.find(item => item.ModuleName.toLowerCase() === name);
    if (!module || path.dirname(await fs.realpath(module.FileName)).toLowerCase() !== expected) throw new Error('PostgreSQL did not load its packaged Microsoft runtime: ' + name);
  }
}

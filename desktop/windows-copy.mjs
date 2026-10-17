import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

// Copy only: no /MIR, /PURGE, /MOVE or deletion of existing user files.
export async function copyWindowsDirectory(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn('robocopy.exe', [source, destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/MT:16', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let diagnostics = '';
    const record = chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-10000); };
    child.stdout.on('data', record); child.stderr.on('data', record);
    child.once('error', reject);
    child.once('exit', code => code !== null && code < 8 ? resolve() : reject(new Error(`Windows directory copy failed (${code}): ${diagnostics}`)));
  });
}

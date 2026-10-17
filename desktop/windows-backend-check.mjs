import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { availablePort, isDesktopBackendReady } from './runtime.mjs';
import { fileURLToPath } from 'node:url';
import { validationEnvironment, redactValidationLog } from './validation-runtime.mjs';
import { assertWindowsVcRuntimeLoaded } from './windows-vc-runtime.mjs';

// Exercise the shipped Node, imports and PostgreSQL before copying the large Electron bundle.
export async function checkWindowsBackend(payload) {
  payload = path.resolve(payload);
  const diagnostics = fileURLToPath(new URL('./validation/', import.meta.url));
  await fs.mkdir(diagnostics, { recursive: true });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'si-production-check-'));
  const startedAt = Date.now();
  const port = await availablePort(0);
  const token = randomBytes(32).toString('hex');
  const child = spawn(path.join(payload, 'bin/node.exe'), [path.join(payload, 'launch.mjs')], {
    cwd: home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: validationEnvironment(home, { PORT: String(port), SUPER_INDIVIDUAL_MCP_TOKEN: token }),
  });
  let output = '';
  const record = chunk => { output += chunk.toString(); };
  child.stdout.on('data', record); child.stderr.on('data', record);
  let launchError;
  let readyOrigin;
  child.on('message', message => {
    if (message?.type === 'si:ready' && Number.isInteger(message.port) && message.port > 0 && message.port < 65536) readyOrigin = `http://127.0.0.1:${message.port}`;
  });
  child.once('error', error => { launchError = error; output += error.stack ?? String(error); });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  const closed = new Promise(resolve => child.once('close', resolve));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    for (let i = 0; i < 300; i++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Production backend exited: ${child.exitCode}`);
      if (readyOrigin && await isDesktopBackendReady(readyOrigin, token)) {
        const postgresPid = Number((await fs.readFile(path.join(home, 'instances/default/db/postmaster.pid'), 'utf8')).split('\n')[0]);
        await assertWindowsVcRuntimeLoaded(postgresPid, path.join(payload, 'server/node_modules/@embedded-postgres/windows-x64/native/bin'));
        console.log(`Production Windows backend and PostgreSQL started successfully (${Math.round((Date.now() - startedAt) / 1000)}s)`); return;
      }
      await sleep(1000);
    }
    throw new Error('Production Windows backend startup timed out');
  } catch (error) {
    console.error(redactValidationLog(output).slice(-40000)); throw error;
  } finally {
    if (child.connected) child.send({ type: 'si:shutdown' });
    await Promise.race([exited, sleep(15000)]);
    if (child.pid && child.exitCode === null && !launchError) execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    await Promise.race([closed, sleep(3000)]);
    await fs.writeFile(path.join(diagnostics, 'windows-smoke-production-backend.log'), redactValidationLog(output));
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

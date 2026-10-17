import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { availablePort } from './runtime.mjs';

// Exercise the shipped Node, imports and PostgreSQL before copying the large Electron bundle.
export async function checkWindowsBackend(payload) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'si-production-check-'));
  const port = await availablePort(0);
  const child = spawn(path.join(payload, 'bin/node.exe'), [path.join(payload, 'launch.mjs')], {
    cwd: home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, SUPER_INDIVIDUAL: 'true', PAPERCLIP_HOME: home,
      PAPERCLIP_CONFIG: path.join(home, 'instances/default/config.json'), PAPERCLIP_INSTANCE_ID: 'default',
      HOST: '127.0.0.1', PORT: String(port), SERVE_UI: 'true', PAPERCLIP_UI_DEV_MIDDLEWARE: 'false' },
  });
  let output = '';
  const record = chunk => { output += chunk.toString(); };
  child.stdout.on('data', record); child.stderr.on('data', record);
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(`Production backend exited: ${child.exitCode}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) {
        console.log('Production Windows backend and PostgreSQL started successfully'); return;
      } } catch {}
      await sleep(1000);
    }
    throw new Error('Production Windows backend startup timed out');
  } catch (error) {
    console.error(output.slice(-40000)); throw error;
  } finally {
    if (child.connected) child.send({ type: 'si:shutdown' });
    await Promise.race([exited, sleep(15000)]);
    if (child.exitCode === null) execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

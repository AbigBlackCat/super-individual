import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acquireRuntimeLock, prepareWindowsPostgres } from './runtime.mjs';
import dotenv from './server/node_modules/dotenv/lib/main.js';
const root = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.PAPERCLIP_HOME;
const releaseLock = await acquireRuntimeLock(path.join(home, 'backend.lock'));
process.once('exit', releaseLock);
if (process.platform === 'win32') process.env.SI_POSTGRES_NATIVE_DIRECTORY = await prepareWindowsPostgres(root, home);
let serverStarted = false, shutdownRequested = false;
const shutdown = () => {
  // Health may be available before startup recovery installs the signal hooks.
  if (!serverStarted) { shutdownRequested = true; return; }
  if (process.platform === 'win32') process.emit('SIGTERM'); else process.kill(process.pid, 'SIGTERM');
};
process.on('message', message => { if (message?.type === 'si:shutdown') shutdown(); });
// An unexpected desktop-process exit must not leave a second database writer.
if (process.connected) process.once('disconnect', () => {
  const origin = `http://127.0.0.1:${process.env.PORT}`;
  void fetch(origin + '/api/individual/pause-all', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}', signal: AbortSignal.timeout(10000) }).catch(() => {}).finally(shutdown);
});
const instance = path.join(home, 'instances/default');
const configPath = path.join(instance, 'config.json');
await fs.mkdir(path.join(instance, 'secrets'), { recursive: true, mode: 0o700 });
try { await fs.access(configPath); } catch {
  const config = {
    $meta: { version: 1, updatedAt: new Date().toISOString(), source: 'configure' },
    database: { mode: 'embedded-postgres', embeddedPostgresDataDir: path.join(instance, 'db'), embeddedPostgresPort: 54329, backup: { enabled: true, intervalMinutes: 60, retentionDays: 30, dir: path.join(instance, 'data/backups') } },
    logging: { mode: 'file', logDir: path.join(instance, 'logs') },
    server: { deploymentMode: 'local_trusted', exposure: 'private', bind: 'loopback', host: '127.0.0.1', port: 3100, allowedHostnames: [], serveUi: true },
    auth: { baseUrlMode: 'auto', disableSignUp: false },
    storage: { provider: 'local_disk', localDisk: { baseDir: path.join(instance, 'data/storage') } },
    secrets: { provider: 'local_encrypted', strictMode: false, localEncrypted: { keyFilePath: path.join(instance, 'secrets/master.key') } },
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(instance, '.env'), `PAPERCLIP_AGENT_JWT_SECRET=${randomBytes(48).toString('base64url')}\nPAPERCLIP_TOOL_ACTION_SIGNING_SECRET=${randomBytes(48).toString('base64url')}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(instance, 'secrets/master.key'), randomBytes(32).toString('base64'), { mode: 0o600 });
}
// Repair the known invalid desktop metadata without changing user settings.
const existingConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
if (existingConfig.$meta?.source === 'super individual') {
  existingConfig.$meta.source = 'configure';
  await fs.writeFile(configPath + '.staged', JSON.stringify(existingConfig, null, 2), { mode: 0o600 });
  await fs.rename(configPath + '.staged', configPath);
}
dotenv.config({ path: path.join(instance, '.env'), override: true, quiet: true });
process.env.PAPERCLIP_MIGRATION_AUTO_APPLY = 'true';
console.info('[si] Loading production backend');
const { startServer } = await import('./server/dist/index.js');
console.info('[si] Starting local server and database');
const startedServer = await startServer();
serverStarted = true;
if (process.connected) process.send({ type: 'si:ready', port: startedServer.listenPort });
if (shutdownRequested) shutdown();

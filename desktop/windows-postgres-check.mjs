import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { availablePort } from './runtime.mjs';

// Exercise the shipped PostgreSQL stop/restart without the large backend graph.
export async function checkWindowsPostgresRestart(payload) {
  const require = createRequire(path.join(payload, 'server/package.json'));
  const { default: EmbeddedPostgres } = await import(pathToFileURL(require.resolve('embedded-postgres')).href);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'si-postgres-restart-'));
  const databaseDir = path.join(home, 'db');
  const database = new EmbeddedPostgres({ databaseDir, port: await availablePort(0), user: 'postgres', password: randomBytes(24).toString('hex'), persistent: true, onLog() {}, onError() {} });
  try {
    await database.initialise();
    for (let cycle = 0; cycle < 3; cycle++) {
      await database.start();
      const pid = Number((await fs.readFile(path.join(databaseDir, 'postmaster.pid'), 'utf8')).split('\n')[0]);
      const client = database.getPgClient('postgres');
      try {
        await client.connect();
        if (cycle === 0) {
          await client.query('CREATE TABLE si_persistence (value text NOT NULL)');
          await client.query("INSERT INTO si_persistence VALUES ('saved before Windows restart')");
        }
        assert.equal((await client.query('SELECT value FROM si_persistence')).rows[0].value, 'saved before Windows restart');
      } finally { await client.end(); }
      await database.stop();
      let stopped = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === 'ESRCH') { stopped = true; break; } throw error; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(stopped, 'PostgreSQL master remained alive after pg_ctl stop');
      assert.equal(await fs.access(path.join(databaseDir, 'postmaster.pid')).then(() => true, () => false), false);
    }
    console.log('Windows PostgreSQL passed three starts, clean stops and disk persistence checks');
  } finally {
    await database.stop();
    await fs.rm(home, { recursive: true, force: true });
  }
}

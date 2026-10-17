import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { availablePort, relocateConfig, migrateLegacyData, safeOpenPath, acquireRuntimeLock } from './runtime.mjs';
test('port conflict selects an available loopback port', async () => {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  try { assert.notEqual(await availablePort(listener.address().port), listener.address().port); } finally { listener.close(); }
});
test('migration keeps the original, rewrites data paths and is idempotent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'si-migrate-'));
  try {
    const from = path.join(dir, 'old'), to = path.join(dir, 'new');
    await mkdir(path.join(from, 'instances/default'), { recursive: true });
    await writeFile(path.join(from, 'instances/default/config.json'), JSON.stringify({ db: path.join(from, 'instances/default/db'), other: from + '-unrelated' }));
    assert.equal(await migrateLegacyData(from, to), true);
    const config = JSON.parse(await readFile(path.join(to, 'instances/default/config.json')));
    assert.equal(config.db, path.join(to, 'instances/default/db')); assert.equal(config.other, from + '-unrelated');
    assert.equal(await migrateLegacyData(from, to), false);
    assert.ok(await readFile(path.join(from, 'instances/default/config.json')));
  } finally { await rm(dir, { recursive: true }); }
});
test('Finder bridge rejects symlink escapes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'si-path-'));
  try { await mkdir(path.join(dir, 'root')); await symlink(os.tmpdir(), path.join(dir, 'root/escape'), process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(safeOpenPath(path.join(dir, 'root/escape'), [path.join(dir, 'root')])); assert.equal(await safeOpenPath(path.join(dir, 'root'), [path.join(dir, 'root')]), await realpath(path.join(dir, 'root'))); } finally { await rm(dir, { recursive: true }); }
});

test('migration refuses a live old database and leaves both sides untouched', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'si-live-'));
  try {
    const from = path.join(dir, 'old'), to = path.join(dir, 'new');
    await mkdir(path.join(from, 'instances/default/db'), { recursive: true });
    await writeFile(path.join(from, 'instances/default/db/postmaster.pid'), String(process.pid));
    await assert.rejects(migrateLegacyData(from, to), /仍在运行/);
    assert.equal(await readFile(path.join(from, 'instances/default/db/postmaster.pid'), 'utf8'), String(process.pid));
  } finally { await rm(dir, { recursive: true }); }
});
test('migration can preserve desktop preferences created before first startup', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'si-desktop-'));
  try {
    const from = path.join(dir, 'old'), to = path.join(dir, 'new');
    await mkdir(path.join(from, 'instances/default'), { recursive: true });
    await writeFile(path.join(from, 'instances/default/config.json'), '{}');
    await mkdir(path.join(to, 'desktop'), { recursive: true });
    await writeFile(path.join(to, 'desktop/preferences'), 'keep');
    await migrateLegacyData(from, to);
    assert.equal(await readFile(path.join(to, 'desktop/preferences'), 'utf8'), 'keep');
  } finally { await rm(dir, { recursive: true }); }
});

test('backend lock prevents two services and recovers after a stale process', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'si-lock-'));
  try {
    const file = path.join(dir, 'backend.lock');
    const release = await acquireRuntimeLock(file);
    await assert.rejects(acquireRuntimeLock(file, 10), /仍在退出/);
    release();
    await writeFile(file, JSON.stringify({ pid: 999999999 }));
    const recovered = await acquireRuntimeLock(file, 10);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid);
    recovered();
  } finally { await rm(dir, { recursive: true }); }
});

import path from 'node:path';
import { access, cp, mkdir, readFile, writeFile, readdir, realpath, stat, rename, rm, lstat, unlink, symlink } from 'node:fs/promises';
import net from 'node:net';
import { readFileSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import os from 'node:os';

export function desktopDataDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  if (env.SI_DATA_DIRECTORY) {
    const paths = platform === 'win32' ? path.win32 : path;
    if (!paths.isAbsolute(env.SI_DATA_DIRECTORY)) throw new Error('SI_DATA_DIRECTORY must be an absolute path');
    return paths.normalize(env.SI_DATA_DIRECTORY);
  }
  if (platform === 'win32') return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'super individual');
  return path.join(home, platform === 'darwin' ? 'Library/Application Support' : '.config', 'super individual');
}
export function desktopBinary(name, platform = process.platform) { return name + (platform === 'win32' ? '.exe' : ''); }
export async function prepareWindowsPostgres(resources, home) {
  const native = path.join(resources, 'server/node_modules/@embedded-postgres/windows-x64/native');
  if (!/[^\x00-\x7f]/.test(native)) return native;
  const directory = path.join(home, 'runtime');
  if (/[^\x00-\x7f]/.test(directory)) throw new Error('PostgreSQL 需要英文运行路径：请使用纯英文的 Windows 用户目录和数据目录。');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const alias = path.join(directory, 'postgres');
  const existing = await lstat(alias).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing) {
    if (!existing.isSymbolicLink()) throw new Error('PostgreSQL runtime alias is not a junction');
    if (await realpath(alias).catch(() => null) === await realpath(native)) return alias;
    await unlink(alias);
  }
  await symlink(native, alias, 'junction');
  return alias;
}
export function desktopSearchPath(resources, platform = process.platform, env = process.env, home = os.homedir()) {
  const paths = platform === 'win32' ? path.win32 : path;
  const extras = platform === 'win32'
    ? [paths.join(env.APPDATA || paths.join(home, 'AppData/Roaming'), 'npm'), paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData/Local'), 'Microsoft/WindowsApps')]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return [paths.join(resources, 'bin'), paths.join(home, '.local/bin'), paths.join(home, '.cargo/bin'), ...extras, env.PATH || env.Path || ''].join(paths.delimiter);
}

export async function exists(file) { try { await access(file); return true; } catch { return false; } }
export async function availablePort(preferred = 3100) {
  const listen = port => new Promise((resolve, reject) => {
    const server = net.createServer(); server.unref(); server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { const actual = server.address().port; server.close(() => resolve(actual)); });
  });
  try { return await listen(preferred); } catch (error) { if (error.code !== 'EADDRINUSE') throw error; return listen(0); }
}
export function relocateConfig(value, from, to) {
  if (typeof value === 'string') return value === from || value.startsWith(from + path.sep) ? to + value.slice(from.length) : value;
  if (Array.isArray(value)) return value.map(item => relocateConfig(item, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocateConfig(item, from, to)]));
  return value;
}
export async function migrateLegacyData(source, target) {
  const marker = path.join(target, '.migration-complete.json');
  if (await exists(marker) || await exists(path.join(target, 'instances/default/config.json'))) return false;
  if (!source || !await exists(source)) { await mkdir(target, { recursive: true, mode: 0o700 }); return false; }
  const pidFile = path.join(source, 'instances/default/db/postmaster.pid');
  if (await exists(pidFile)) {
    const pid = Number((await readFile(pidFile, 'utf8')).split('\n')[0]);
    try { process.kill(pid, 0); throw new Error('旧 Paperclip 数据库仍在运行。请先停止旧服务后重新打开应用。'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await mkdir(path.dirname(target), { recursive: true });
  // Build a complete cold copy before exposing the new data directory.
  const staging = target + '.migrating-' + process.pid;
  const previous = target + '.before-migration-' + Date.now();
  await rm(staging, { recursive: true, force: true });
  await cp(source, staging, { recursive: true, errorOnExist: true, force: false });
  try {
  for (const instance of await readdir(path.join(staging, 'instances'))) {
    const configPath = path.join(staging, 'instances', instance, 'config.json');
    if (await exists(configPath)) {
      const config = relocateConfig(JSON.parse(await readFile(configPath, 'utf8')), source, target);
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    }
  }
  await writeFile(path.join(staging, '.migration-complete.json'), JSON.stringify({ source, completedAt: new Date().toISOString(), originalRetained: true }), { mode: 0o600 });
  const hadTarget = await exists(target);
  if (hadTarget) {
    for (const item of await readdir(target)) {
      if (!['desktop', 'logs'].includes(item)) throw new Error('目标数据目录非空，已保留原状，请检查：' + target);
      await cp(path.join(target, item), path.join(staging, item), { recursive: true, force: false });
    }
    await rename(target, previous);
  }
  try { await rename(staging, target); }
  catch (error) { if (hadTarget) await rename(previous, target); throw error; }
  } finally { await rm(staging, { recursive: true, force: true }); }
  return true;
}
export async function safeOpenPath(candidate, roots) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw new Error('请选择本机绝对路径');
  const resolved = await realpath(candidate);
  const allowed = await Promise.all(roots.map(root => realpath(root).catch(() => null)));
  if (!allowed.some(root => root && (resolved === root || resolved.startsWith(root + path.sep)))) throw new Error('此路径不属于当前工作区或应用数据目录');
  return resolved;
}

export async function acquireRuntimeLock(file, timeoutMs = 20000) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.close();
      return () => { try { if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const previous = JSON.parse(await readFile(file, 'utf8'));
        if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('Invalid runtime lock');
        try { process.kill(previous.pid, 0); }
        catch (probe) { if (probe.code === 'ESRCH') { await rm(file, { force: true }); continue; } throw probe; }
      } catch (probe) { if (probe.code === 'ENOENT') continue; }
      if (Date.now() >= deadline) throw new Error('另一个本机服务仍在退出，请稍后重新打开应用。');
      await new Promise(resolve => setTimeout(resolve, Math.min(200, timeoutMs)));
    }
  }
}

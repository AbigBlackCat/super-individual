import fs from 'node:fs/promises';
import path from 'node:path';

export async function prepareWindowsPostgresRuntime(payload) {
const postgresModule = path.join(payload, 'server/node_modules/@embedded-postgres/windows-x64/dist/index.js');
await fs.writeFile(postgresModule + '.staged', `import path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst native = process.env.SI_POSTGRES_NATIVE_DIRECTORY || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native');\nexport const pg_ctl = path.join(native, 'bin/pg_ctl.exe');\nexport const initdb = path.join(native, 'bin/initdb.exe');\nexport const postgres = path.join(native, 'bin/postgres.exe');\n`);
await fs.rename(postgresModule + '.staged', postgresModule);
// embedded-postgres forwards initdb stdout but omits stderr, hiding the actual
// initialization failure. Patch only the shipped copy, keeping store hardlinks intact.
const postgresRuntime = path.join(payload, 'server/node_modules/embedded-postgres/dist/index.js');
let postgresCode = await fs.readFile(postgresRuntime, 'utf8');
if (!postgresCode.includes('si: initdb diagnostics')) {
  const marker = "                process.on('exit', (code) => {";
  if (!postgresCode.includes(marker)) throw new Error('Unsupported embedded-postgres diagnostics layout');
  postgresCode = postgresCode.replace(marker, "                // si: initdb diagnostics\n                process.stderr?.on('data', chunk => this.options.onError(chunk.toString('utf-8')));\n                process.once('error', reject);\n" + marker);
  await fs.writeFile(postgresRuntime + '.staged', postgresCode);
  await fs.rename(postgresRuntime + '.staged', postgresRuntime);
}
if (!postgresCode.includes('si: graceful Windows PostgreSQL stop')) {
  const marker = '    stop() {\n        return __awaiter(this, void 0, void 0, function* () {\n';
  if (!postgresCode.includes(marker)) throw new Error('Unsupported embedded-postgres stop layout');
  postgresCode = postgresCode.replace(marker, marker + `            // si: graceful Windows PostgreSQL stop
            if (platform() === 'win32') {
                if (!this.process || this.process.exitCode !== null) { this.process = undefined; return; }
                const { pg_ctl } = yield bin;
                yield new Promise((resolve, reject) => {
                    const control = spawn(pg_ctl, ['stop', '-D', this.options.databaseDir, '-m', 'fast', '-w', '-t', '30'], { windowsHide: true });
                    let diagnostics = '';
                    control.stdout?.on('data', chunk => { diagnostics += chunk; this.options.onLog(chunk.toString()); });
                    control.stderr?.on('data', chunk => { diagnostics += chunk; this.options.onError(chunk.toString()); });
                    control.once('error', reject);
                    control.once('exit', code => code === 0 ? resolve() : reject(new Error('pg_ctl stop failed (' + code + '): ' + diagnostics.slice(-4000))));
                });
                this.process = undefined;
                if (this.options.persistent === false) yield fs.rm(this.options.databaseDir, { recursive: true, force: true });
                return;
            }
`);
  await fs.writeFile(postgresRuntime + '.staged', postgresCode);
  await fs.rename(postgresRuntime + '.staged', postgresRuntime);
}
}

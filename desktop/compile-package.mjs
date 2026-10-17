// Windows SI uses the existing legacy CLI adapters, so its build needs Runner JS, not the Unix daemon.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = process.cwd();
const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
function pnpm(args) {
  const entry = process.env.npm_execpath;
  if (!entry || !/\.(cjs|mjs|js)$/i.test(entry)) throw new Error('Run this helper through pnpm exec');
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: directory, stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}
if (manifest.name === '@paperclipai/paperclip-runner') pnpm(['run', 'build:typescript']);
else if (manifest.name === '@paperclipai/server') {
  pnpm(['exec', 'tsc']);
  for (const relative of ['onboarding-assets', 'built-ins', 'services/scripts']) await fs.cp(path.join(directory, 'src', relative), path.join(directory, 'dist', relative), { recursive: true });
  await fs.cp(path.join(root, 'packages/paperclip-runner/dist'), path.join(directory, 'dist/vendor/paperclip-runner'), { recursive: true });
  const stamp = spawnSync(process.execPath, ['scripts/write-build-stamp.mjs'], { cwd: directory, stdio: 'inherit' });
  if (stamp.status !== 0) process.exit(stamp.status || 1);
} else if (manifest.scripts?.build) pnpm(['run', 'build']);

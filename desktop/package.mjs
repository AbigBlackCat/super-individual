import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
const desktop = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(desktop);
const payload = path.join(desktop, 'payload');
const require = createRequire(path.join(repo, 'server/package.json'));
const sharp = require('sharp');
const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect x="24" y="24" width="976" height="976" rx="214" fill="#171717"/><path d="M548 354c-35-43-89-58-137-37-67 30-49 105 14 128l43 16c105 40 107 160 15 205-61 30-136 12-181-35" fill="none" stroke="#fff" stroke-width="63" stroke-linecap="round"/><path d="M677 449v225" stroke="#fff" stroke-width="66" stroke-linecap="round"/><circle cx="677" cy="326" r="36" fill="#fff"/></svg>';
const iconset = path.join(desktop, 'app.iconset');
await fs.mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) await sharp(Buffer.from(icon)).resize(size * scale).png().toFile(path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`));
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(desktop, 'app.icns')]);
await sharp(Buffer.from(icon.replace('fill="#171717"', 'fill="none"').replaceAll('#fff', '#000'))).resize(22, 22).png().toFile(path.join(desktop, 'tray.png'));
await fs.mkdir(path.join(payload, 'bin'), { recursive: true });
await fs.mkdir(path.join(payload, 'runner'), { recursive: true });
await fs.copyFile('/usr/local/bin/node', path.join(payload, 'bin/node'));
await fs.chmod(path.join(payload, 'bin/node'), 0o755);
await fs.copyFile(path.join(repo, 'packages/paperclip-runner/dist/bin/paperclip-runnerd'), path.join(payload, 'runner/paperclip-runnerd'));
await fs.chmod(path.join(payload, 'runner/paperclip-runnerd'), 0o755);
await fs.copyFile(path.join(desktop, 'si-mcp.mjs'), path.join(payload, 'si-mcp.mjs'));
await fs.copyFile(path.join(desktop, 'launch.mjs'), path.join(payload, 'launch.mjs'));
await fs.copyFile(path.join(desktop, 'runtime.mjs'), path.join(payload, 'runtime.mjs'));
await fs.cp(path.join(repo, 'server/dist'), path.join(payload, 'server/dist'), { recursive: true, force: true });
await fs.cp(path.join(repo, 'packages/paperclip-runner/dist'), path.join(payload, 'server/dist/vendor/paperclip-runner'), { recursive: true, force: true });
await fs.cp(path.join(repo, 'ui/dist'), path.join(payload, 'server/ui-dist'), { recursive: true, force: true });
await fs.copyFile(path.join(repo, 'LICENSE'), path.join(payload, 'LICENSE-Paperclip'));
await fs.writeFile(path.join(payload, 'migration.json'), JSON.stringify({ legacyData: path.join(path.dirname(repo), 'paperclip-data') }));
// pnpm deploy retains development exports. Use the package's upstream publish
// contract, replacing inodes atomically so pnpm hardlinks cannot change source files.
async function normalizeManifests(dir) {
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await normalizeManifests(file);
    else if (item.name === 'package.json') {
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      if (manifest.name?.startsWith('@paperclipai/') && manifest.publishConfig) {
        const next = { ...manifest, ...manifest.publishConfig }; delete next.publishConfig;
        await fs.writeFile(file + '.staged', JSON.stringify(next, null, 2)); await fs.rename(file + '.staged', file);
      }
    }
  }
}
await normalizeManifests(path.join(payload, 'server'));
const staging = path.join(desktop, 'app-source');
await fs.mkdir(staging, { recursive: true });
for (const name of ['main.cjs', 'preload.cjs', 'runtime.mjs', 'tray.png']) await fs.copyFile(path.join(desktop, name), path.join(staging, name));
await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: 'super-individual', productName: 'super individual', version: '0.1.0', main: 'main.cjs', description: '个人任务与智能体协作工作台', author: 'Super Individual', license: 'MIT' }));
const locations = await packager({ dir: staging, name: 'super individual', appBundleId: 'local.superindividual.app', executableName: 'super individual', platform: 'darwin', arch: 'arm64', electronVersion: '44.9.0', electronZipDir: path.join(desktop, 'electron-cache'), out: path.join(desktop, 'out'), overwrite: true, prune: false, asar: false, icon: path.join(desktop, 'app.icns'), extraResource: [payload], appCategoryType: 'public.app-category.productivity', appCopyright: 'Based on Paperclip (MIT), original attribution retained.' });
// The packager copies extra resources with absolute symlink targets. Relocate
// pnpm links into the bundle so it runs after the checkout is moved or removed.
const appPath = path.join(locations[0], 'super individual.app');
const installedPayload = path.join(appPath, 'Contents/Resources/payload');
async function relocateLinks(dir) {
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isSymbolicLink()) {
      const target = await fs.readlink(file);
      if (path.isAbsolute(target)) {
        const relocated = target === path.join(repo, 'server') ? path.join(installedPayload, 'server') : target === payload || target.startsWith(payload + path.sep) ? path.join(installedPayload, path.relative(payload, target)) : null;
        if (!relocated) throw new Error('External bundle link: ' + file);
        await fs.unlink(file); await fs.symlink(path.relative(path.dirname(file), relocated), file);
      }
    } else if (item.isDirectory()) await relocateLinks(file);
  }
}
await relocateLinks(appPath);
execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath]);
console.log('Packaged:', locations[0]);

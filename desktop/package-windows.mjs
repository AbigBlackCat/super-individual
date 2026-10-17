import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { checkWindowsBackend } from './windows-backend-check.mjs';
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this package on Windows x64 so its PostgreSQL and native Node modules match');
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node 24 for the packaged backend');
const desktop = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(desktop);
const payload = path.join(desktop, 'payload');
const require = createRequire(path.join(root, 'server/package.json'));
const sharp = require('sharp');
const svg = await fs.readFile(path.join(desktop, 'icon.svg'));
const png = await sharp(svg).resize(256, 256).png().toBuffer();
const header = Buffer.alloc(22); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
await fs.writeFile(path.join(desktop, 'app.ico'), Buffer.concat([header, png]));
await sharp(svg).resize(22, 22).png().toFile(path.join(desktop, 'tray.png'));
await fs.mkdir(path.join(payload, 'bin'), { recursive: true });
await fs.copyFile(process.execPath, path.join(payload, 'bin/node.exe'));
for (const name of ['launch.mjs', 'runtime.mjs', 'si-mcp.mjs']) await fs.copyFile(path.join(desktop, name), path.join(payload, name));
await fs.cp(path.join(root, 'server/dist'), path.join(payload, 'server/dist'), { recursive: true });
await fs.cp(path.join(root, 'ui/dist'), path.join(payload, 'server/ui-dist'), { recursive: true });
await fs.copyFile(path.join(root, 'LICENSE'), path.join(payload, 'LICENSE-Paperclip'));
await fs.writeFile(path.join(payload, 'migration.json'), JSON.stringify({ legacyData: null }));
async function normalize(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await fs.realpath(file);
      await fs.rm(file, { force: true, recursive: true });
      await fs.cp(target, file, { recursive: true, dereference: true });
      if ((await fs.stat(file)).isDirectory()) await normalize(file);
    } else if (entry.isDirectory()) await normalize(file);
    else if (entry.name === 'package.json') {
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      if (manifest.name?.startsWith('@paperclipai/') && manifest.publishConfig) {
        Object.assign(manifest, manifest.publishConfig); delete manifest.publishConfig;
        await fs.writeFile(file + '.staged', JSON.stringify(manifest, null, 2)); await fs.rename(file + '.staged', file);
      }
    }
  }
}
await normalize(path.join(payload, 'server'));
await checkWindowsBackend(payload);
const staging = path.join(desktop, 'app-source-windows');
await fs.mkdir(staging, { recursive: true });
for (const name of ['main.cjs', 'preload.cjs', 'runtime.mjs', 'tray.png']) await fs.copyFile(path.join(desktop, name), path.join(staging, name));
await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: 'super-individual', productName: 'super individual', version: '0.1.0', main: 'main.cjs', license: 'MIT', author: 'super individual contributors' }));
const outputs = await packager({ dir: staging, name: 'super individual', executableName: 'super individual', platform: 'win32', arch: 'x64', electronVersion: '44.9.0', out: path.join(desktop, 'out'), overwrite: true, prune: false, asar: false, icon: path.join(desktop, 'app.ico'), extraResource: [payload], win32metadata: { ProductName: 'super individual', FileDescription: 'Personal task and agent collaboration board', CompanyName: 'super individual contributors' }, appCopyright: 'Based on Paperclip (MIT). Original attribution retained.' });
await fs.copyFile(path.join(root, 'LICENSE'), path.join(outputs[0], 'LICENSE-Paperclip.txt'));
await fs.writeFile(path.join(outputs[0], '使用说明.txt'), 'super individual · Windows x64\r\n\r\n解压整个文件夹后，双击 super individual.exe。无需安装 Node 或 pnpm。\r\n首次打开创建自己的工作区；本软件不含任何用户数据、CLI 登录凭据或密钥。\r\nClaude Code / Codex CLI 需要在本机另行安装并登录。\r\n数据目录：%APPDATA%\\super individual\r\n关闭窗口继续在后台运行；通过托盘图标重新打开，菜单中的退出会停止并保存。\r\n首版使用现有 CLI 执行通道，未包含上游只支持 Unix 的原生 Runner。\r\n此版本尚未配置商业代码签名证书。\r\n');
console.log('Windows package:', outputs[0]);

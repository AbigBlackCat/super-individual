const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
let window, tray, backend, origin, quitting = false, backendReady = false;
const authorizedDirectories = new Set();
app.setName('super individual');
if (process.env.SI_DATA_DIRECTORY && !path.isAbsolute(process.env.SI_DATA_DIRECTORY)) throw new Error('SI_DATA_DIRECTORY must be an absolute path');
const dataDirectory = process.env.SI_DATA_DIRECTORY ? path.normalize(process.env.SI_DATA_DIRECTORY) : path.join(app.getPath('appData'), 'super individual');
app.setPath('userData', path.join(dataDirectory, 'desktop'));
if (!app.requestSingleInstanceLock()) app.quit();
else if (process.argv.includes('--quit')) app.quit();
else {
  app.on('second-instance', (_event, argv) => { if (argv.includes('--quit')) void quitSafely(); else showWindow(); });
  app.whenReady().then(start).catch(error => { quitting = true; stopBackend(); dialog.showErrorBox('super individual 无法启动', error.stack || String(error)); app.quit(); });
  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    void quitSafely();
  });
}
function showWindow() { if (window && !window.isDestroyed()) { window.show(); window.focus(); } }
function stopBackend() {
  if (!backend || backend.exitCode !== null) return;
  if (process.platform === 'win32' && backend.connected) backend.send({ type: 'si:shutdown' });
  else backend.kill('SIGTERM');
}
async function start() {
  window = new BrowserWindow({ width: 1440, height: 920, minWidth: 1000, minHeight: 680, title: 'super individual', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  const loading = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>super individual</title><style>body{margin:0;background:#171717;color:#eee;font:16px system-ui;display:grid;place-items:center;height:100vh}.card{text-align:center}strong{font-size:56px}p{color:#aaa}.dot{width:32px;height:32px;margin:24px auto;border:3px solid #555;border-top-color:#eee;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style><div class="card"><strong>si</strong><h1>正在打开你的工作台</h1><p>首次启动可能需要几分钟，请稍候。</p><div class="dot"></div></div></html>';
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(loading));
  const runtime = await import('./runtime.mjs');
  const resources = app.isPackaged ? path.join(process.resourcesPath, 'payload') : path.join(__dirname, 'payload');
  const migration = path.join(resources, 'migration.json');
  const legacy = fs.existsSync(migration) ? JSON.parse(fs.readFileSync(migration, 'utf8')).legacyData : null;
  await runtime.migrateLegacyData(legacy, dataDirectory);
  fs.mkdirSync(path.join(dataDirectory, 'logs'), { recursive: true, mode: 0o700 });
  const port = await runtime.availablePort(); origin = `http://127.0.0.1:${port}`;
  const mcpToken = randomBytes(32).toString('hex');
  const log = fs.openSync(path.join(dataDirectory, 'logs/desktop-backend.log'), 'a', 0o600);
  const inheritedPath = runtime.desktopSearchPath(resources);
  backend = spawn(path.join(resources, 'bin', runtime.desktopBinary('node')), [path.join(resources, 'launch.mjs')], {
    cwd: resources, env: { ...process.env, PATH: inheritedPath, SUPER_INDIVIDUAL: 'true', SUPER_INDIVIDUAL_MCP_TOKEN: mcpToken, PAPERCLIP_HOME: dataDirectory, PAPERCLIP_CONFIG: path.join(dataDirectory, 'instances/default/config.json'), PAPERCLIP_INSTANCE_ID: 'default', HOST: '127.0.0.1', PORT: String(port), SERVE_UI: 'true', PAPERCLIP_UI_DEV_MIDDLEWARE: 'false', PAPERCLIP_MIGRATION_AUTO_APPLY: 'true', ...(process.platform === 'win32' ? {} : { PAPERCLIP_RUNNER_BINARY: path.join(resources, 'runner/paperclip-runnerd') }) }, stdio: ['ignore', log, log, 'ipc'], detached: process.platform !== 'win32', windowsHide: true,
  });
  fs.closeSync(log);
  let launchError;
  backend.once('error', error => { launchError = error; });
  backend.once('exit', (code, signal) => { if (!quitting && backendReady) { void dialog.showMessageBox({ type: 'error', title: '本机服务已停止', message: 'super individual 的本机服务意外停止。', detail: `退出状态：${code ?? signal}。重新打开应用可恢复，数据保留在本机。`, buttons: ['退出应用'] }).then(() => { quitting = true; app.quit(); }); } });
  const deadline = Date.now() + (process.platform === 'win32' ? 300000 : 120000);
  let ready = false;
  while (Date.now() < deadline) {
    if (launchError) throw new Error('无法启动包内 Node：' + launchError.message, { cause: launchError });
    if (await runtime.isDesktopBackendReady(origin, mcpToken)) { ready = true; break; }
    if (backend.exitCode !== null) throw new Error('本机服务启动失败，请查看：' + path.join(dataDirectory, 'logs/desktop-backend.log'));
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('本机服务启动超时，请查看：' + path.join(dataDirectory, 'logs/desktop-backend.log'));
  backendReady = true;
  const mcpDirectory = path.join(dataDirectory, 'mcp');
  fs.mkdirSync(mcpDirectory, { recursive: true, mode: 0o700 });
  const connectionFile = path.join(mcpDirectory, 'connection.json');
  fs.writeFileSync(connectionFile + '.tmp', JSON.stringify({ origin, token: mcpToken, pid: backend.pid }), { mode: 0o600 });
  fs.renameSync(connectionFile + '.tmp', connectionFile);
  app.once('will-quit', () => { try { fs.unlinkSync(connectionFile); } catch {} });
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png')); icon.setTemplateImage(true);
  tray = new Tray(icon); tray.setToolTip('super individual'); tray.on('click', showWindow);
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 super individual', click: showWindow }, { type: 'separator' }, { label: '退出', click: quitSafely }]));
  ipcMain.handle('si:runtime-status', event => { assertSender(event); return { dataDirectory, version: app.getVersion() }; });
  ipcMain.handle('si:choose-directory', async event => {
    assertSender(event); const result = await dialog.showOpenDialog(window, { title: '选择任务工作目录', properties: ['openDirectory', 'createDirectory'] });
    const selected = result.canceled ? null : result.filePaths[0]; if (selected) authorizedDirectories.add(await fs.promises.realpath(selected)); return selected;
  });
  ipcMain.handle('si:open-path', async (event, candidate) => {
    assertSender(event);
    const companies = await fetch(origin + '/api/companies').then(response => response.json());
    for (const company of companies) {
      const tasks = await fetch(origin + `/api/individual/${company.id}/tasks`).then(response => response.json());
      for (const task of tasks) { const directory = task.assigneeAdapterOverrides?.superIndividual?.directory; if (directory) authorizedDirectories.add(directory); }
    }
    const value = await runtime.safeOpenPath(candidate, [dataDirectory, ...authorizedDirectories]); const failure = await shell.openPath(value); if (failure) throw new Error(failure);
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'super individual', submenu: [{ role: 'about', label: '关于 super individual' }, { type: 'separator' }, { role: 'hide', label: '隐藏' }, { role: 'hideOthers', label: '隐藏其他应用' }, { type: 'separator' }, { label: '退出 super individual', accelerator: 'Command+Q', click: quitSafely }] }, { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] }, { label: '窗口', submenu: [{ role: 'close', label: '关闭窗口' }, { role: 'minimize', label: '最小化' }, { label: '显示工作台', click: showWindow }] }]));
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url) && !url.startsWith(origin + '/')) void shell.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  await window.loadURL(origin); window.show();
}
function assertSender(event) { if (!window || event.sender !== window.webContents || new URL(event.senderFrame.url).origin !== origin) throw new Error('不允许的桌面请求来源'); }
let quittingPromise;
function quitSafely() {
  if (quittingPromise) return quittingPromise;
  quittingPromise = (async () => {
    try {
      if (origin) {
        const companies = await fetch(origin + '/api/companies').then(response => response.json()); let active = 0;
        for (const company of companies) { const tasks = await fetch(origin + `/api/individual/${company.id}/tasks`).then(response => response.json()); active += tasks.filter(task => ['planning', 'executing', 'reviewing'].includes(task.assigneeAdapterOverrides?.superIndividual?.phase)).length; }
        if (active) { const result = await dialog.showMessageBox({ type: 'question', title: '仍有任务正在运行', message: `${active} 个任务仍在运行。停止并保存后，下次打开可手动恢复。`, buttons: ['继续在后台运行', '停止并退出'], defaultId: 0, cancelId: 0 }); if (result.response !== 1) return; }
        const paused = await fetch(origin + '/api/individual/pause-all', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' }); if (!paused.ok) throw new Error('无法保存运行状态，请稍后再试');
      }
      quitting = true;
      if (backend && backend.exitCode === null) { stopBackend(); await Promise.race([new Promise(resolve => backend.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 15000))]); if (backend.exitCode === null) { if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(backend.pid), '/T', '/F'], { windowsHide: true }); else process.kill(-backend.pid, 'SIGKILL'); } }
      tray?.destroy(); app.quit();
    } catch (error) { await dialog.showMessageBox({ type: 'error', message: '退出未完成', detail: String(error), buttons: ['返回工作台'] }); }
  })().finally(() => { quittingPromise = null; });
  return quittingPromise;
}

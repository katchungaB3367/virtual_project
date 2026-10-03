'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, protocol, net, session, powerMonitor, Menu } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Vault, VaultError, generatePassword } = require('./vault');
const { ActivitySession, ClipboardGuard } = require('./session');

protocol.registerSchemesAsPrivileged([{ scheme: 'quietvault', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('QuietVault');
const index = process.argv.indexOf('--vault');
const initialPath = index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : path.join(os.homedir(), '.quietvault', 'passwords-node.vault');
let window;
let vault;
let dirty = false;
let attempts = 0;
let retryAfter = 0;
let exiting = false;
let closePending = false;
let queue = Promise.resolve();
const activity = new ActivitySession();
const clip = new ClipboardGuard(clipboard);
const enqueue = task => {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
};
const makeVault = filename => new Vault(filename, { onCompromised: () => enqueue(() => lock('Access to the file changed. The vault was locked.')) });

async function state() {
  return { path: vault.path, exists: await vault.exists(), unlocked: vault.unlocked };
}
async function lock(reason = 'Vault locked. Saved entries remain encrypted.') {
  activity.stop();
  dirty = false;
  await vault.lock();
  if (window && !window.isDestroyed()) window.webContents.send('vault:locked', reason);
  await clip.clear();
}
async function confirm(message, detail, affirmative = 'Discard changes') {
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning', message, detail, buttons: ['Cancel', affirmative], defaultId: 0, cancelId: 0, noLink: true
  });
  return response === 1;
}
async function discardAllowed() {
  return !dirty || confirm('Discard unsaved changes?', 'The current form has not been saved.');
}
function checkSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== 'quietvault://app/index.html') {
    throw new VaultError('Request denied.');
  }
}
function requireSession() { vault.requireUnlocked(); }
async function request(action, data) {
  if (activity.expired()) await lock('Automatically locked after five minutes. Unsaved changes were discarded.');
  switch (action) {
    case 'state': return state();
    case 'activity': activity.touch(); return null;
    case 'choose': {
      if (vault.unlocked) throw new VaultError('Lock the vault before choosing another file.');
      if (!['open', 'new'].includes(data)) throw new VaultError('Invalid file action.');
      let filename;
      if (data === 'open') {
        const result = await dialog.showOpenDialog(window, { title: 'Open encrypted vault', properties: ['openFile'], filters: [{ name: 'QuietVault', extensions: ['vault'] }] });
        filename = result.filePaths[0];
      } else {
        const result = await dialog.showSaveDialog(window, { title: 'Choose a new vault location', defaultPath: 'new-vault.vault', filters: [{ name: 'QuietVault', extensions: ['vault'] }] });
        filename = result.filePath;
      }
      if (filename) {
        const next = makeVault(filename);
        if (data === 'new' && await next.exists()) throw new VaultError('This file already exists. Use Open existing vault or choose a new name.');
        vault = next;
      }
      return state();
    }
    case 'authenticate': {
      if (Date.now() < retryAfter) throw new VaultError('Please wait a few seconds before trying again.');
      if (!data || typeof data.password !== 'string' || !['create', 'unlock'].includes(data.mode)) throw new VaultError('Invalid login request.');
      try {
        if (data.mode === 'create') {
          if (data.password !== data.confirm) throw new VaultError('The master passwords do not match.');
          await vault.create(data.password);
        } else await vault.unlock(data.password);
      } catch (error) { attempts++; retryAfter = Date.now() + Math.min(attempts * 2000, 10000); throw error; }
      attempts = 0;
      retryAfter = 0;
      dirty = false;
      activity.start();
      return state();
    }
    case 'list': requireSession(); return vault.list(data);
    case 'get': requireSession(); return vault.get(data);
    case 'save': {
      requireSession();
      if (!data || (data.id !== null && typeof data.id !== 'string')) throw new VaultError('Invalid entry request.');
      const id = await vault.save(data.values, data.id);
      dirty = false;
      return id;
    }
    case 'delete': {
      requireSession();
      vault.get(data);
      if (!await confirm('Delete this saved entry?', 'There is no undo. Existing backups are unchanged.', 'Delete entry')) return false;
      if (activity.expired()) { await lock('Session expired. Deletion was cancelled.'); return false; }
      requireSession();
      await vault.delete(data);
      await clip.clear();
      dirty = false;
      return true;
    }
    case 'generate': requireSession(); return generatePassword();
    case 'copy':
      requireSession();
      if (typeof data !== 'string' || !data || data.length > 1000) throw new VaultError('Enter a password before copying.');
      await clip.copy(data); return null;
    case 'dirty': requireSession(); dirty = data === true; return null;
    case 'confirmDiscard': requireSession(); return discardAllowed();
    case 'confirmGenerate': requireSession(); return confirm('Replace the password in this form?', 'This does not change the password at its website. Save the entry to keep it.', 'Generate password');
    case 'backup': {
      requireSession();
      if (dirty) throw new VaultError('Save or discard your edits before making a backup.');
      const { filePath } = await dialog.showSaveDialog(window, { title: 'Save encrypted backup to a new file', defaultPath: `quietvault-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.vault`, filters: [{ name: 'QuietVault', extensions: ['vault'] }] });
      if (!filePath) return false;
      if (activity.expired()) { await lock('Session expired. Backup was cancelled.'); return false; }
      requireSession();
      await vault.backup(filePath); return true;
    }
    case 'lock':
      if (vault.unlocked && !await discardAllowed()) return false;
      await lock(); return true;
    default: throw new VaultError('Unsupported action.');
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    vault = makeVault(initialPath);
    protocol.handle('quietvault', request => {
      const url = new URL(request.url);
      const assets = new Set(['/index.html', '/styles.css', '/renderer.js']);
      if (url.host !== 'app' || !assets.has(url.pathname) || url.search) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(path.join(__dirname, 'ui', url.pathname.slice(1))).href);
    });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({
      width: 1140, height: 880, minWidth: 860, minHeight: 660, title: 'QuietVault', backgroundColor: '#f4f3ed', show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged }
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: 'QuietVault', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }
    ]));
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('render-process-gone', () => enqueue(() => lock('The interface stopped. Vault locked.')));
    ipcMain.handle('vault:request', (event, action, data) => enqueue(async () => {
      try { checkSender(event); return { ok: true, value: await request(action, data) }; }
      catch (error) {
        const message = error instanceof VaultError ? error.message : error.code === 'EEXIST' ? 'That destination already exists. Choose a new filename.' : 'File operation failed. Check the location, permissions and available space.';
        return { ok: false, error: message };
      }
    }));
    window.on('close', event => {
      if (exiting) return;
      event.preventDefault();
      if (closePending) return;
      closePending = true;
      enqueue(async () => {
        if (await discardAllowed()) { await lock(); exiting = true; app.quit(); }
        closePending = false;
      });
    });
    app.on('before-quit', event => {
      if (!exiting) { event.preventDefault(); window.close(); }
    });
    powerMonitor.on('suspend', () => enqueue(() => lock('Locked because the computer went to sleep. Unsaved changes were discarded.')));
    powerMonitor.on('lock-screen', () => enqueue(() => lock('Locked with the computer. Unsaved changes were discarded.')));
    setInterval(() => { if (activity.expired()) enqueue(() => lock('Automatically locked after five minutes. Unsaved changes were discarded.')); }, 1000).unref();
    await window.loadURL('quietvault://app/index.html');
    window.show();
  }).catch(() => { console.error('QuietVault could not start. Run from an interactive desktop with installed dependencies.'); app.exit(1); });
  app.on('window-all-closed', () => { clip.clear(); app.quit(); });
}

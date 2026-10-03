'use strict';
// Real Electron integration test. All credentials and files are disposable fixtures.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Vault } = require('../src/vault');

(async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quietvault-desktop-'));
  const filename = path.join(folder, 'demo.vault');
  const backup = path.join(folder, 'backup.vault');
  const master = 'fictional desktop demo passphrase';
  let application;
  const failures = [];
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ args: [path.resolve(__dirname, '..'), '--vault', filename], env, timeout: 30000 });
    const page = await application.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => failures.push(error.message));
    await page.locator('#authenticate:not([disabled])').waitFor();
    await fs.mkdir(path.resolve('artifacts'), { recursive: true });
    await page.screenshot({ path: 'artifacts/login.png' });
    await page.locator('#master').fill(master); await page.locator('#confirm').fill(master);
    await page.locator('#authenticate').click();
    await page.locator('#vault-view:not([hidden])').waitFor();
    await page.locator('#title').fill('University portal');
    await page.locator('#username').fill('student@example.test');
    await page.locator('#password').fill('FictionalPassword42!');
    await page.locator('#website').fill('https://example.test');
    await page.locator('#notes').fill('Demonstration account. No real credentials.');
    await page.locator('#save').click();
    await page.getByText('Saved securely to your local vault.', { exact: true }).waitFor();
    assert.equal(await page.locator('.account-row').count(), 1);
    await page.locator('#copy').click();
    assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), 'FictionalPassword42!');
    await page.locator('#show-password').click();
    assert.equal(await page.locator('#password').getAttribute('type'), 'text');
    await page.locator('#show-password').click();
    await page.locator('#search').fill('missing account');
    await page.waitForFunction(() => document.querySelector('#count').textContent === '0');
    await page.locator('#search').fill('');
    await page.waitForFunction(() => document.querySelector('#count').textContent === '1');
    await page.locator('#title').fill('University account'); await page.locator('#save').click();
    await page.getByText('Saved securely to your local vault.', { exact: true }).waitFor();
    await page.screenshot({ path: 'artifacts/vault.png' });
    // Verify hardened renderer, API surface, and IPC frame boundary.
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    assert.equal(await page.evaluate(() => typeof process), 'undefined');
    assert.equal(await page.evaluate(() => typeof window.quietvault.invoke), 'undefined');
    const preferences = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
    await application.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }); }, backup);
    await page.locator('#backup').click();
    await page.getByText('Encrypted backup created. Keep its master password safe.', { exact: true }).waitFor();
    const restored = new Vault(backup);
    try { await restored.unlock(master); assert.equal(restored.list()[0].title, 'University account'); }
    finally { await restored.lock(); }
    await page.locator('#lock').click();
    await page.locator('#login-view:not([hidden])').waitFor();
    await page.locator('#master:not([disabled])').waitFor();
    assert.equal(await page.locator('#password').inputValue(), '');
    assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), '');
    await page.locator('#master').fill(master); await page.locator('#authenticate').click();
    await page.locator('.account-row').waitFor(); await page.locator('.account-row').click();
    assert.equal(await page.locator('#title').inputValue(), 'University account');
    // Native dialogue answers are stubbed only inside this test process.
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await page.locator('#title').fill('Unsaved change'); await page.locator('#lock').click();
    assert.equal(await page.locator('#vault-view').isVisible(), true);
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await page.locator('#discard').click();
    await page.getByText('Unsaved changes discarded.', { exact: true }).waitFor();
    assert.equal(await page.locator('#title').inputValue(), 'University account');
    await page.locator('#delete').click();
    await page.getByText('Entry deleted. Existing backups are unchanged.', { exact: true }).waitFor();
    assert.equal(await page.locator('.account-row').count(), 0);
    // Simulate expiry in the main process without shortening production timeout.
    await page.locator('#title').fill('Unsaved timeout example');
    await application.evaluate(() => { globalThis.originalNow = Date.now; Date.now = () => globalThis.originalNow() + 301000; });
    await page.evaluate(() => window.quietvault.state());
    await page.locator('#login-view:not([hidden])').waitFor();
    assert.equal(await page.locator('#title').inputValue(), '');
    await application.evaluate(() => { Date.now = globalThis.originalNow; delete globalThis.originalNow; });
    assert.deepEqual(failures, []);
    console.log('Electron integration passed: create, CRUD, search, mask/reveal, copy/cleanup, backup/restore, lock/unlock, unsaved-change cancellation, idle expiry, isolated renderer.');
    console.log('Runtime:', await application.evaluate(() => ({ electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome })));
  } finally {
    if (application) await application.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

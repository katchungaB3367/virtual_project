'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Vault, KDF, generatePassword, MAX_BYTES } = require('../src/vault');
const MASTER = 'a unique fictional master passphrase';
const ENTRY = { title: 'Example university', username: 'student@example.test', password: 'FictionalSecret42!', website: 'https://example.test', notes: 'Fictional private note' };

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quietvault-test-'));
  const filename = path.join(directory, 'demo.vault');
  const vault = new Vault(filename, options);
  t.after(async () => { await vault.lock(); await fs.rm(directory, { recursive: true, force: true }); });
  await vault.create(MASTER);
  return { vault, filename, directory };
}
test('all credential fields persist encrypted and unlock correctly', async t => {
  const { vault, filename } = await fixture(t);
  const id = await vault.save(ENTRY);
  const raw = await fs.readFile(filename, 'utf8');
  for (const secret of [MASTER, ...Object.values(ENTRY)]) assert.ok(!raw.includes(secret));
  await vault.lock(); await vault.unlock(MASTER);
  const record = vault.get(id);
  for (const field of Object.keys(ENTRY)) assert.equal(record[field], ENTRY[field]);
});
test('wrong password is rejected and locked access is denied', async t => {
  const { vault } = await fixture(t);
  await vault.lock();
  await assert.rejects(vault.unlock('wrong password value'), /incorrect master/);
  assert.equal(vault.unlocked, false);
  assert.throws(() => vault.list(), /Unlock/);
  await vault.unlock(MASTER);
});
test('authenticated encryption rejects changes to ciphertext, IV and tag', async t => {
  const { vault, filename } = await fixture(t);
  const original = JSON.parse(await fs.readFile(filename, 'utf8'));
  await vault.lock();
  for (const field of ['data', 'iv', 'tag']) {
    const data = structuredClone(original);
    const buffer = Buffer.from(data[field], 'base64'); buffer[0] ^= 1;
    data[field] = buffer.toString('base64'); await fs.writeFile(filename, JSON.stringify(data));
    await assert.rejects(vault.unlock(MASTER), /incorrect master/);
    assert.equal(vault.unlocked, false);
  }
});
test('malformed, old formats and arbitrary KDF resource settings are rejected', async t => {
  const { vault, filename } = await fixture(t);
  await vault.lock();
  for (const data of ['not json', 'null', '[]', '{"version":1}', JSON.stringify({ version: 2, cipher: 'aes-256-gcm', kdf: { ...KDF, N: 2 ** 29 } })]) {
    await fs.writeFile(filename, data); await assert.rejects(vault.unlock(MASTER));
    assert.equal(vault.unlocked, false);
  }
});
test('oversized files are rejected before parsing', async t => {
  const { vault, filename } = await fixture(t); await vault.lock();
  await fs.writeFile(filename, Buffer.alloc(MAX_BYTES + 1));
  await assert.rejects(vault.unlock(MASTER), /8 MiB/);
});
test('edit, search and deletion survive reopening; list omits secrets', async t => {
  const { vault } = await fixture(t);
  const id = await vault.save(ENTRY);
  assert.equal(vault.list('UNIVERSITY').length, 1);
  assert.equal(vault.list(ENTRY.password).length, 0);
  assert.equal(vault.list()[0].password, undefined);
  assert.equal(vault.list()[0].notes, undefined);
  await vault.save({ ...ENTRY, title: 'Updated' }, id);
  assert.equal(vault.list().length, 1); assert.equal(vault.get(id).title, 'Updated');
  await vault.delete(id); await vault.lock(); await vault.unlock(MASTER);
  assert.deepEqual(vault.list(), []);
});
test('invalid values do not change saved state', async t => {
  const { vault, filename } = await fixture(t);
  const original = await fs.readFile(filename);
  for (const values of [{ ...ENTRY, title: ' ' }, { ...ENTRY, password: '' }, { ...ENTRY, notes: 'a'.repeat(10001) }, { ...ENTRY, username: 2 }]) await assert.rejects(vault.save(values));
  assert.deepEqual(await fs.readFile(filename), original);
  assert.deepEqual(vault.list(), []);
});
test('Unicode and exact password whitespace are preserved', async t => {
  const { vault } = await fixture(t);
  const id = await vault.save({ ...ENTRY, title: '大学 café', password: '  🔑 password  ' });
  await vault.lock(); await vault.unlock(MASTER);
  assert.equal(vault.get(id).password, '  🔑 password  ');
});
test('backup opens independently and never overwrites destinations', async t => {
  const { vault, directory, filename } = await fixture(t);
  const id = await vault.save(ENTRY);
  const destination = path.join(directory, 'backup.vault');
  await vault.backup(destination);
  await assert.rejects(vault.backup(destination), { code: 'EEXIST' });
  await assert.rejects(vault.backup(filename));
  const other = new Vault(destination);
  try { await other.unlock(MASTER); assert.deepEqual(other.get(id), vault.get(id)); }
  finally { await other.lock(); }
});
test('failed atomic replacement preserves old file and saved state', async t => {
  const { vault, filename, directory } = await fixture(t, { replace: async () => { throw new Error('simulated failure'); } });
  const original = await fs.readFile(filename);
  await assert.rejects(vault.save(ENTRY), /simulated failure/);
  assert.deepEqual(await fs.readFile(filename), original);
  assert.deepEqual(vault.list(), []);
  assert.ok(!(await fs.readdir(directory)).some(name => name.endsWith('.tmp')));
});
test('external modifications are not overwritten', async t => {
  const { vault, filename } = await fixture(t);
  await fs.writeFile(filename, 'external data');
  await assert.rejects(vault.save(ENTRY), /changed outside/);
  assert.equal(await fs.readFile(filename, 'utf8'), 'external data');
});
test('a second session is refused and can unlock after release', async t => {
  const { vault, filename } = await fixture(t);
  const other = new Vault(filename);
  try {
    await assert.rejects(other.unlock(MASTER), /another process/);
    await vault.lock(); await other.unlock(MASTER);
  } finally { await other.lock(); }
});
test('creation never replaces an existing file', async t => {
  const { vault, filename } = await fixture(t);
  const original = await fs.readFile(filename); await vault.lock();
  await assert.rejects(vault.create(MASTER), /already exists/);
  assert.deepEqual(await fs.readFile(filename), original);
});
test('short and blank master passwords are refused', async t => {
  const { vault } = await fixture(t); await vault.lock();
  await assert.rejects(vault.create('short'), /14 characters/);
  await assert.rejects(vault.create(' '.repeat(20)), /14 characters/);
});
test('permissions restrict POSIX vault access and returned entries are copies', async t => {
  const { vault, filename } = await fixture(t);
  if (process.platform !== 'win32') assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  const id = await vault.save(ENTRY); vault.get(id).password = 'modified';
  assert.equal(vault.get(id).password, ENTRY.password);
});
test('fresh encryption nonces are used on subsequent saves', async t => {
  const { vault, filename } = await fixture(t);
  const before = JSON.parse(await fs.readFile(filename));
  await vault.save(ENTRY); const after = JSON.parse(await fs.readFile(filename));
  assert.notEqual(before.iv, after.iv); assert.equal(before.salt, after.salt);
});
test('concurrent operations are rejected rather than losing records', async t => {
  const { vault } = await fixture(t);
  const pending = vault.save(ENTRY);
  await assert.rejects(vault.save({ ...ENTRY, title: 'Concurrent' }), /still running/);
  await pending; assert.equal(vault.list().length, 1);
});
test('password generation uses the required length and character groups', () => {
  const values = new Set(Array.from({ length: 100 }, () => generatePassword()));
  assert.equal(values.size, 100);
  for (const value of values) {
    assert.equal(value.length, 24);
    for (const expression of [/[a-z]/, /[A-Z]/, /[0-9]/, /[!@#$%&*+\-=?]/]) assert.match(value, expression);
  }
  assert.throws(() => generatePassword(8)); assert.throws(() => generatePassword(24.5));
});

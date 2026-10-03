'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const lockfile = require('proper-lockfile');
const scrypt = promisify(crypto.scrypt);
const MAX_BYTES = 8 * 1024 * 1024;
const KDF = Object.freeze({ name: 'scrypt', N: 131072, r: 8, p: 1 });
const FIELDS = ['title', 'username', 'password', 'website', 'notes'];
const AAD = Buffer.from('QuietVault:2:aes-256-gcm');

class VaultError extends Error {}
function requirePassword(password, creating = false) {
  if (typeof password !== 'string' || password.length > 1000 || !password.length) {
    throw new VaultError('Enter a master password of no more than 1,000 characters.');
  }
  if (creating && (password.length < 14 || !password.trim())) {
    throw new VaultError('Use a master password of at least 14 characters.');
  }
}
function decode(value, size) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (size !== undefined && bytes.length !== size)) throw new Error('Invalid length');
  return bytes;
}
function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 10000) throw new VaultError('Unsupported record collection.');
  const ids = new Set();
  for (const entry of entries) {
    if (!entry || Object.keys(entry).sort().join(',') !== [...FIELDS, 'id', 'updated'].sort().join(',')) throw new VaultError('Invalid entry fields.');
    if (Object.values(entry).some(value => typeof value !== 'string')) throw new VaultError('Entry fields must be text.');
    if (!entry.title.trim() || !entry.password || !/^[0-9a-f-]{36}$/.test(entry.id) || ids.has(entry.id)) throw new VaultError('Invalid or duplicate entry.');
    for (const field of FIELDS) {
      if (entry[field].length > (field === 'notes' ? 10000 : 1000)) throw new VaultError('A field exceeds its supported length.');
    }
    ids.add(entry.id);
  }
}
function generatePassword(length = 24) {
  if (!Number.isInteger(length) || length < 16 || length > 128) throw new VaultError('Choose a password length from 16 to 128.');
  const groups = ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789', '!@#$%&*+-=?'];
  const alphabet = groups.join('');
  for (;;) {
    const value = Array.from({ length }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
    if (groups.every(group => [...value].some(c => group.includes(c)))) return value;
  }
}

class Vault {
  constructor(filename, options = {}) {
    this.path = path.resolve(filename);
    this.key = null;
    this.salt = null;
    this.records = [];
    this.snapshot = null;
    this.release = null;
    this.busy = false;
    this.onCompromised = options.onCompromised || (() => {});
    this.replace = options.replace || fs.rename;
  }
  get unlocked() { return this.key !== null; }
  async exists() {
    try { await fs.access(this.path); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async acquire() {
    await fs.mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    // Canonicalise the parent and any existing file so aliases share a lock.
    const parent = await fs.realpath(path.dirname(this.path));
    this.path = path.join(parent, path.basename(this.path));
    if (await this.exists()) this.path = await fs.realpath(this.path);
    try {
      this.release = await lockfile.lock(this.path, {
        realpath: false, stale: 15000, update: 5000, retries: 0,
        onCompromised: () => { this.clearSecrets(); this.onCompromised(); }
      });
    } catch (error) {
      if (error.code === 'ELOCKED') throw new VaultError('This vault is open in another process. Close it and try again; after a crash allow 15 seconds.');
      throw error;
    }
  }
  clearSecrets() {
    this.key?.fill(0);
    this.key = null;
    this.salt = null;
    this.records = [];
    this.snapshot = null;
  }
  async lock() {
    this.clearSecrets();
    const release = this.release;
    this.release = null;
    if (release) await release().catch(() => {});
  }
  requireUnlocked() {
    if (!this.unlocked) throw new VaultError('Unlock your vault first.');
  }
  async exclusive(action) {
    if (this.busy) throw new VaultError('Another vault operation is still running.');
    this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }
  async read() {
    const handle = await fs.open(this.path, 'r');
    try {
      if ((await handle.stat()).size > MAX_BYTES) throw new VaultError('Vault exceeds the 8 MiB limit.');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > MAX_BYTES) throw new VaultError('Vault exceeds the 8 MiB limit.');
      return buffer.subarray(0, offset);
    } finally { await handle.close(); }
  }
  async create(password) {
    return this.exclusive(async () => {
      if (this.unlocked) throw new VaultError('Lock your current vault first.');
      requirePassword(password, true);
      await this.acquire();
      try {
        if (await this.exists()) throw new VaultError('A file already exists here. Choose another location or unlock it.');
        this.salt = crypto.randomBytes(16);
        this.key = await scrypt(password, this.salt, 32, { ...KDF, maxmem: 256 * 1024 * 1024 });
        await this.commit([]);
      } catch (error) { await this.lock(); throw error; }
    });
  }
  async unlock(password) {
    return this.exclusive(async () => {
      if (this.unlocked) throw new VaultError('The vault is already unlocked.');
      requirePassword(password);
      await this.acquire();
      let key;
      try {
        const raw = await this.read();
        let envelope;
        try { envelope = JSON.parse(raw.toString('utf8')); }
        catch { throw new VaultError('Not a supported QuietVault file.'); }
        if (envelope?.version !== 2 || envelope?.cipher !== 'aes-256-gcm' ||
            !envelope.kdf || Object.keys(envelope.kdf).length !== 4 ||
            Object.entries(KDF).some(([k, v]) => envelope.kdf[k] !== v)) {
          throw new VaultError('Unsupported vault format. Node.js version 2 cannot open Python version 1 vaults.');
        }
        try {
          const salt = decode(envelope.salt, 16);
          const iv = decode(envelope.iv, 12);
          const tag = decode(envelope.tag, 16);
          const ciphertext = decode(envelope.data);
          key = await scrypt(password, salt, 32, { ...KDF, maxmem: 256 * 1024 * 1024 });
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
          decipher.setAAD(AAD);
          decipher.setAuthTag(tag);
          const clear = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
          let payload;
          try { payload = JSON.parse(clear.toString('utf8')); }
          finally { clear.fill(0); }
          if (!payload || Object.keys(payload).join() !== 'entries') throw new Error('Invalid payload');
          validateEntries(payload.entries);
          this.key = key;
          this.salt = salt;
          this.records = payload.entries;
          this.snapshot = raw;
        } catch { throw new VaultError('Cannot unlock: incorrect master password or damaged vault.'); }
      } catch (error) { key?.fill(0); await this.lock(); throw error; }
    });
  }
  list(query = '') {
    this.requireUnlocked();
    if (typeof query !== 'string' || query.length > 1000) throw new VaultError('Invalid search text.');
    const term = query.trim().toLocaleLowerCase();
    // Passwords and notes stay out of list responses.
    return this.records.filter(e => [e.title, e.username, e.website].join(' ').toLocaleLowerCase().includes(term))
      .sort((a, b) => a.title.localeCompare(b.title)).map(({ id, title, username, website }) => ({ id, title, username, website }));
  }
  get(id) {
    this.requireUnlocked();
    const entry = this.records.find(e => e.id === id);
    if (!entry) throw new VaultError('That entry no longer exists.');
    return { ...entry };
  }
  async save(values, id = null) {
    return this.exclusive(async () => {
      this.requireUnlocked();
      if (!values || Object.keys(values).sort().join() !== [...FIELDS].sort().join() || Object.values(values).some(v => typeof v !== 'string')) throw new VaultError('Supply the five supported text fields.');
      const entries = this.records.map(e => ({ ...e }));
      const entry = { ...values, title: values.title.trim(), id: id || crypto.randomUUID(), updated: new Date().toISOString() };
      if (id !== null) {
        const index = entries.findIndex(e => e.id === id);
        if (index < 0) throw new VaultError('That entry no longer exists.');
        entries[index] = entry;
      } else entries.push(entry);
      validateEntries(entries);
      await this.commit(entries);
      return entry.id;
    });
  }
  async delete(id) {
    return this.exclusive(async () => {
      this.requireUnlocked();
      this.get(id);
      await this.commit(this.records.filter(e => e.id !== id));
    });
  }
  async commit(entries) {
    this.requireUnlocked();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(AAD);
    const clear = Buffer.from(JSON.stringify({ entries }));
    let data;
    try { data = Buffer.concat([cipher.update(clear), cipher.final()]); }
    finally { clear.fill(0); }
    const raw = Buffer.from(JSON.stringify({ version: 2, cipher: 'aes-256-gcm', kdf: KDF,
      salt: this.salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
    if (raw.length > MAX_BYTES) throw new VaultError('The vault would exceed its 8 MiB limit.');
    if (this.snapshot && (!(await this.exists()) || !(await this.read()).equals(this.snapshot))) throw new VaultError('The file changed outside QuietVault. Lock and reopen it before editing.');
    const temporary = path.join(path.dirname(this.path), `.quietvault-${crypto.randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(raw); await handle.sync(); }
      finally { await handle.close(); }
      this.requireUnlocked();
      if (this.snapshot) await this.replace(temporary, this.path);
      else await fs.link(temporary, this.path); // Never replace an existing file at creation.
      this.records = entries;
      this.snapshot = raw;
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async backup(destination) {
    return this.exclusive(async () => {
      this.requireUnlocked();
      if (path.resolve(destination) === this.path) throw new VaultError('Choose a different backup location.');
      const handle = await fs.open(destination, 'wx', 0o600);
      try {
        await handle.writeFile(this.snapshot);
        await handle.sync();
      } catch (error) {
        await handle.close();
        await fs.unlink(destination).catch(() => {});
        throw error;
      }
      await handle.close();
    });
  }
}

module.exports = { Vault, VaultError, FIELDS, KDF, MAX_BYTES, generatePassword };

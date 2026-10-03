'use strict';

class ActivitySession {
  constructor({ now = () => Date.now(), timeout = 300000 } = {}) {
    this.now = now;
    this.timeout = timeout;
    this.last = null;
  }
  start() { this.last = this.now(); }
  stop() { this.last = null; }
  expired() { return this.last !== null && this.now() - this.last >= this.timeout; }
  touch() {
    if (this.expired()) return false;
    if (this.last !== null) this.last = this.now();
    return true;
  }
}

class ClipboardGuard {
  constructor(clipboard, { schedule = setTimeout, cancel = clearTimeout } = {}) {
    this.clipboard = clipboard;
    this.schedule = schedule;
    this.cancel = cancel;
    this.value = null;
    this.timer = null;
    this.pending = Promise.resolve();
  }
  enqueue(action) {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }
  copy(value) {
    return this.enqueue(async () => {
      await this.cleanup();
      await this.clipboard.writeText(value);
      this.value = value;
      this.timer = this.schedule(() => this.clear(), 30000);
    });
  }
  clear() {
    return this.enqueue(() => this.cleanup());
  }
  async cleanup() {
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
    try {
      if (this.value !== null && await this.clipboard.readText() === this.value) {
        await this.clipboard.clear();
      }
    } catch {
      // Clipboard unavailability must never prevent the vault from locking.
    } finally { this.value = null; }
  }
}

module.exports = { ActivitySession, ClipboardGuard };

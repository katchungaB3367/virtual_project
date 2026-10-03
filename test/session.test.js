'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ActivitySession, ClipboardGuard } = require('../src/session');
test('idle sessions expire and incoming activity cannot revive them', () => {
  let now = 0; const session = new ActivitySession({ now: () => now });
  session.start(); now = 299999; assert.equal(session.expired(), false);
  now = 300000; assert.equal(session.expired(), true); assert.equal(session.touch(), false);
  session.stop(); assert.equal(session.expired(), false);
});
test('activity extends an unexpired session', () => {
  let now = 0; const session = new ActivitySession({ now: () => now });
  session.start(); now = 200000; assert.equal(session.touch(), true);
  now = 400000; assert.equal(session.expired(), false);
});
test('clipboard cleanup clears own value on timeout', async () => {
  let value = ''; let callback;
  const clipboard = { writeText: async text => { value = text; }, readText: async () => value, clear: async () => { value = ''; } };
  const guard = new ClipboardGuard(clipboard, { schedule: (fn, delay) => { assert.equal(delay, 30000); callback = fn; return 1; }, cancel: () => {} });
  await guard.copy('fictional password'); assert.equal(value, 'fictional password'); await callback(); assert.equal(value, '');
});
test('clipboard cleanup preserves a newer item copied by another app', async () => {
  let value = ''; const clipboard = { writeText: text => { value = text; }, readText: () => value, clear: () => { value = ''; } };
  const guard = new ClipboardGuard(clipboard, { schedule: () => 1, cancel: () => {} });
  await guard.copy('fictional password'); value = 'another application'; await guard.clear(); assert.equal(value, 'another application');
});
test('clipboard access failure does not block locking', async () => {
  const clipboard = { writeText: async () => {}, readText: async () => { throw new Error('access unavailable'); } };
  const guard = new ClipboardGuard(clipboard, { schedule: () => 1, cancel: () => {} });
  await guard.copy('fictional password'); await guard.clear(); assert.equal(guard.value, null);
});

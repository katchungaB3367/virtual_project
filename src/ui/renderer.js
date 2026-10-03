'use strict';
const api = window.quietvault;
const $ = id => document.getElementById(id);
const fields = ['title', 'username', 'password', 'website', 'notes'];
let unlocked = false;
let exists = false;
let selected = null;
let dirty = false;
let busy = false;
let epoch = 0;
let listRequest = 0;
let activityAt = 0;

async function call(method, ...args) {
  const result = await api[method](...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function status(text, error = false) {
  const target = $(unlocked ? 'status' : 'login-message');
  target.textContent = text;
  target.classList.toggle('error', error);
}
function buttonStates() {
  for (const element of document.querySelectorAll('button, input, textarea')) element.disabled = busy;
  $('delete').disabled = busy || !selected;
}
async function run(action) {
  if (busy) return;
  busy = true; document.body.classList.add('busy'); buttonStates();
  try { await action(); }
  catch (error) { status(error.message, true); }
  finally { busy = false; document.body.classList.remove('busy'); buttonStates(); }
}
function hidePassword() {
  $('password').type = 'password';
  $('show-password').textContent = 'Show';
  $('show-password').setAttribute('aria-pressed', 'false');
}
function clearForm(entry = null) {
  selected = entry?.id || null;
  for (const field of fields) $(field).value = entry?.[field] || '';
  dirty = false;
  hidePassword();
  $('editor-heading').textContent = selected ? 'Edit entry' : 'New entry';
  $('save-state').textContent = selected ? 'SAVED' : 'READY';
  $('delete').disabled = busy || !selected;
}
function showState(state, message = '') {
  epoch++;
  unlocked = state.unlocked;
  exists = state.exists;
  $('vault-path').textContent = state.path;
  $('login-view').hidden = unlocked;
  $('vault-view').hidden = !unlocked;
  $('session-label').textContent = unlocked ? '● Unlocked' : '● Locked';
  $('master').value = ''; $('confirm').value = '';
  $('confirmation').hidden = exists;
  $('confirm').required = !exists;
  $('welcome').textContent = exists ? 'Welcome back.' : 'A quiet place for your passwords.';
  $('intro').textContent = exists ? 'Unlock your local vault. Everything is right where you left it.' : 'Create your local vault and keep the details that matter together.';
  $('authenticate').textContent = exists ? 'Unlock vault →' : 'Create vault →';
  $('master').minLength = exists ? 1 : 14;
  clearForm();
  $('search').value = '';
  $('account-list').replaceChildren();
  $('side-count').textContent = '—';
  if (message) status(message);
  if (!unlocked) $('master').focus();
}
async function refresh() {
  const generation = epoch;
  const request = ++listRequest;
  const entries = await call('list', $('search').value);
  if (!unlocked || generation !== epoch || request !== listRequest) return;
  $('count').textContent = String(entries.length);
  $('side-count').textContent = $('search').value ? '—' : String(entries.length);
  $('account-list').replaceChildren();
  $('empty-list').hidden = entries.length !== 0;
  $('empty-list').querySelector('h3').textContent = $('search').value ? 'No matches yet.' : 'A fresh start.';
  $('empty-list').querySelector('p').textContent = $('search').value ? 'Try another account name or username.' : 'Add your first account. We’ll keep it here for you.';
  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `account-row${entry.id === selected ? ' active' : ''}`;
    button.dataset.entryId = entry.id;
    button.setAttribute('aria-label', `${entry.title}, ${entry.username}`);
    for (const [className, text] of [['account-icon', entry.title.slice(0, 1).toUpperCase()], ['account-title', entry.title], ['account-user', entry.username]]) {
      const span = document.createElement('span'); span.className = className; span.textContent = text; button.append(span);
    }
    button.addEventListener('click', () => run(async () => {
      if (entry.id === selected || !await allowDiscard()) return;
      const generation = epoch;
      const record = await call('get', entry.id);
      if (generation !== epoch || !unlocked) return;
      clearForm(record); await call('dirty', false); await refresh(); status('Entry loaded. Password hidden.');
    }));
    $('account-list').append(button);
  }
}
async function allowDiscard() { return !dirty || await call('confirmDiscard'); }
async function resetEntry() {
  if (!await allowDiscard() || !unlocked) return;
  clearForm(); await call('dirty', false); await refresh(); status('Ready for a new entry.');
}
async function saveEntry() {
  if (!unlocked || !$('entry-form').reportValidity()) return;
  const values = Object.fromEntries(fields.map(field => [field, $(field).value]));
  const generation = epoch;
  const id = await call('save', { id: selected, values });
  if (generation !== epoch || !unlocked) return;
  selected = id; dirty = false;
  $('editor-heading').textContent = 'Edit entry'; $('save-state').textContent = 'SAVED';
  await refresh(); status('Saved securely to your local vault.');
}
$('login-form').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    const data = { mode: exists ? 'unlock' : 'create', password: $('master').value, confirm: $('confirm').value };
    $('master').value = ''; $('confirm').value = '';
    status('Opening your vault…');
    const state = await call('authenticate', data);
    showState(state); await refresh(); status('Your vault is open.');
  });
});
for (const [id, mode] of [['open-vault', 'open'], ['new-location', 'new']]) {
  $(id).addEventListener('click', () => run(async () => showState(await call('choose', mode))));
}
$('entry-form').addEventListener('submit', event => { event.preventDefault(); run(saveEntry); });
$('entry-form').addEventListener('input', () => {
  if (!unlocked) return;
  dirty = true; $('save-state').textContent = 'UNSAVED'; status('Unsaved changes — choose Save entry to keep them.');
  call('dirty', true).catch(error => status(error.message, true));
});
$('search').addEventListener('input', () => refresh().catch(error => status(error.message, true)));
$('new-entry').addEventListener('click', () => run(resetEntry));
$('discard').addEventListener('click', () => run(async () => {
  if (!await allowDiscard() || !unlocked) return;
  const generation = epoch;
  const entry = selected ? await call('get', selected) : null;
  if (generation !== epoch || !unlocked) return;
  clearForm(entry); await call('dirty', false); status('Unsaved changes discarded.');
}));
$('delete').addEventListener('click', () => run(async () => {
  if (selected && await call('remove', selected) && unlocked) {
    clearForm(); await refresh(); status('Entry deleted. Existing backups are unchanged.');
  }
}));
$('show-password').addEventListener('click', () => {
  const reveal = $('password').type === 'password';
  $('password').type = reveal ? 'text' : 'password';
  $('show-password').textContent = reveal ? 'Hide' : 'Show';
  $('show-password').setAttribute('aria-pressed', String(reveal));
});
$('generate').addEventListener('click', () => run(async () => {
  if ($('password').value && !await call('confirmGenerate')) return;
  const generation = epoch;
  const value = await call('generate');
  if (generation !== epoch || !unlocked) return;
  $('password').value = value; hidePassword(); dirty = true;
  $('save-state').textContent = 'UNSAVED'; await call('dirty', true);
  status('Password generated. Save the entry to keep it.');
}));
$('copy').addEventListener('click', () => run(async () => {
  await call('copy', $('password').value); status('Password copied. Clipboard cleanup is attempted in 30 seconds.');
}));
$('backup').addEventListener('click', () => run(async () => {
  if (await call('backup')) status('Encrypted backup created. Keep its master password safe.');
}));
$('lock').addEventListener('click', () => run(() => call('lock')));
api.onLocked(reason => {
  // Clear secret DOM values synchronously, before requesting any further state.
  showState({ unlocked: false, exists: true, path: $('vault-path').textContent }, reason);
});
for (const event of ['keydown', 'pointerdown', 'wheel']) document.addEventListener(event, () => {
  if (!unlocked || Date.now() - activityAt < 1000) return;
  activityAt = Date.now(); call('activity').catch(() => {});
}, { capture: true, passive: true });
document.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || !unlocked) return;
  if (event.key.toLowerCase() === 's') { event.preventDefault(); run(saveEntry); }
  if (event.key.toLowerCase() === 'l') { event.preventDefault(); run(() => call('lock')); }
});
run(async () => showState(await call('state')));

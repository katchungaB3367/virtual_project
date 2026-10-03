# QuietVault

A **Node.js desktop password manager built with Electron**, following the
A project's Node.js requirement. Runs in its own
desktop window, with no web server, browser tab or Python dependency.

## Run

Use **Node.js 22.12.0 or later** (Node.js 24 is selected by `.nvmrc`).

```sh
node --version
npm ci
npm start
```

If you use nvm, run `nvm install` and `nvm use` in this folder first. The initial
setup downloads npm dependencies and Electron. Subsequent vault operations are
local and offline.

For a separate demonstration vault:

```sh
npm start -- --vault demo.vault
```

Default: `~/.quietvault/passwords-node.vault`. Create a master password of at
least 14 characters, then enter an account name and password and click **Save
entry**. There is no master-password recovery.

## Features

- Create/unlock a vault; lock/log out; five-minute inactivity lock.
- Add, edit, delete and search credentials.
- Mask/reveal, generate and copy passwords; best-effort clipboard cleanup after
  30 seconds and on locking.
- Node.js `crypto.scrypt` key derivation and AES-256-GCM authenticated encryption.
- Atomic file replacement, cooperative locking, external-change detection and
  encrypted backups.
- Isolated, sandboxed Electron renderer with a restricted preload bridge.
- Sleep and screen-lock handling where Electron supplies those events.

Use Ctrl+S / Command+S to save and Ctrl+L / Command+L to lock. Automatic locking
**discards unsaved edits**; manual locking asks first.

## Verify

```sh
npm test
npm run test:desktop
npm run docs
```

The desktop test needs an interactive desktop. It uses temporary fictional data
and saves review screenshots under ignored `artifacts/`. The documentation
builder uses Node.js, and verifies the guide's 5,000-word Markdown source count.



## Source layout

| Location | Purpose |
| --- | --- |
| `src/main.js` | Electron lifecycle, validated IPC, native dialogues, sessions |
| `src/preload.js` | Restricted renderer API |
| `src/vault.js` | Node.js encryption and persistence |
| `src/session.js` | Inactivity and clipboard policies |
| `src/ui/` | Local HTML, CSS and JavaScript interface |
| `test/` | Node.js automated tests |
| `scripts/` | Desktop test and documentation builder |
| `legacy/python/` | Archived initial prototype; not used by this application |

## Data compatibility and scope

The Node.js application uses **vault format version 2**. Earlier Python version 1
vaults are rejected without modification; no automatic migration is provided.
The separate default filename avoids overwriting an earlier vault.

Educational prototype, not independently security audited. Use fictional data
for assessment. No cloud synchronisation, browser extension, password reset,
master-password change, or installer bundle. JavaScript memory erasure and
clipboard-history removal are not guaranteed. Other platforms need testing.

The brief prohibits AI-generated assessment content. The guide is labelled
AI-generated technical documentation. Complete the actual team report, project
records and individual reflection yourselves, following tutor guidance.

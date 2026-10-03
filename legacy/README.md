# Earlier Python prototype

The active application is Electron/Node.js at the project root. These files
preserve the earlier Python prototype for reference only. They are not required
to run, test or document the Node.js application.

Python version 1 vaults use a different encryption format. The Node.js version
rejects them rather than modifying them and uses a separate default filename,
`passwords-node.vault`. No automatic migration is implemented. Keep any original
vault and its master password if you used the earlier prototype.

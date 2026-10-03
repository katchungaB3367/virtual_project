"""Desktop integration check using temporary demonstration data only."""
from pathlib import Path
import sys
import tempfile
import time
import tkinter as tk
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from quietvault.app import App, IDLE_SECONDS

with tempfile.TemporaryDirectory() as folder:
    root = tk.Tk()
    app = App(root, Path(folder) / "demo.vault")
    root.update()
    app.master.set("demonstration master passphrase")
    app.confirm.set("demonstration master passphrase")
    app.authenticate()
    root.update()
    app.values["title"].set("Demonstration account")
    app.values["username"].set("student@example.test")
    app.values["password"].set("demonstration-password-42")
    app.save()
    root.update()
    assert len(app.vault.entries()) == 1
    app.copy_password()
    assert root.clipboard_get() == "demonstration-password-42"
    app.clear_clipboard()
    app.search.set("demonstration")
    root.update()
    assert len(app.tree.get_children()) == 1
    app.values["title"].set("Changed account")
    app.save()
    root.update()
    app.lock()
    root.update()
    assert not app.vault.unlocked
    app.master.set("demonstration master passphrase")
    app.authenticate()
    root.update()
    entry = app.vault.entries()[0]
    assert entry["title"] == "Changed account"
    app.load(entry)
    with patch("quietvault.app.messagebox.askyesno", return_value=True):
        app.delete()
    assert not app.vault.entries()
    app.values["title"].set("Unsaved example")
    app.last_activity = time.monotonic() - IDLE_SECONDS - 1
    app.tick()
    root.update()
    assert not app.vault.unlocked
    app.close()
print("Desktop integration passed: create, save, copy, search, edit, lock, unlock, delete, idle lock.")

"""Native Tk desktop interface for QuietVault."""
from __future__ import annotations

import argparse
from pathlib import Path
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from .vault import FIELDS, Vault, VaultError, generate_password

IDLE_SECONDS = 300
CLIPBOARD_SECONDS = 30


class App:
    def __init__(self, root, path):
        self.root = root
        self.vault = Vault(path)
        self.selected = None
        self.dirty = False
        self.loading = False
        self.copied = None
        self.clipboard_job = None
        self.last_activity = time.monotonic()
        self.failed_attempts = 0
        self.retry_after = 0
        root.title("QuietVault — Local password manager")
        root.geometry("1060x740")
        root.minsize(900, 680)
        root.configure(bg="#f5f4ef")
        style = ttk.Style(root)
        style.theme_use("clam")
        style.configure("TFrame", background="#f5f4ef")
        style.configure("TLabel", background="#f5f4ef", foreground="#182f2a", font=("Helvetica", 12))
        style.configure("Title.TLabel", font=("Helvetica", 26, "bold"))
        style.configure("Heading.TLabel", font=("Helvetica", 17, "bold"))
        style.configure("Muted.TLabel", foreground="#5c6b65", font=("Helvetica", 11))
        style.configure("TButton", padding=(12, 9), font=("Helvetica", 11))
        style.configure("Accent.TButton", background="#235749", foreground="white")
        style.map("Accent.TButton", background=[("active", "#173f34")])
        style.configure("TEntry", padding=8, font=("Helvetica", 12))
        style.configure("Treeview", rowheight=34, font=("Helvetica", 11), background="white", fieldbackground="white")
        style.configure("Treeview.Heading", font=("Helvetica", 11, "bold"), padding=8)
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.bind_all("<KeyPress>", self.activity, add="+")
        root.bind_all("<ButtonPress>", self.activity, add="+")
        root.bind_all("<MouseWheel>", self.activity, add="+")
        root.bind("<Control-l>", lambda e: self.lock())
        root.bind("<Command-l>", lambda e: self.lock())
        root.bind("<Control-s>", lambda e: self.save() if self.vault.unlocked else None)
        root.bind("<Command-s>", lambda e: self.save() if self.vault.unlocked else None)
        self.show_login()
        root.after(1000, self.tick)

    def activity(self, event=None):
        # Check expiry before an event can extend an already expired session.
        if self.vault.unlocked and time.monotonic() - self.last_activity >= IDLE_SECONDS:
            self.lock(automatic=True)
        self.last_activity = time.monotonic()

    def tick(self):
        if self.vault.unlocked and time.monotonic() - self.last_activity >= IDLE_SECONDS:
            self.lock(automatic=True)
        self.root.after(1000, self.tick)

    def clear_view(self):
        for child in self.root.winfo_children():
            child.destroy()
        self.root.unbind("<Return>")

    def show_login(self, notice=""):
        self.clear_view()
        self.root.title("QuietVault — Locked")
        outer = ttk.Frame(self.root, padding=36)
        outer.pack(fill="both", expand=True)
        ttk.Label(outer, text="QUIETVAULT", style="Muted.TLabel").pack(anchor="w")
        card = ttk.Frame(outer, padding=30)
        card.place(relx=.5, rely=.45, anchor="center", width=590)
        exists = self.vault.path.exists()
        ttk.Label(card, text="Welcome back." if exists else "A quiet place for your passwords.", style="Title.TLabel", wraplength=510).pack(anchor="w", pady=(0, 12))
        ttk.Label(card, text="Unlock your local vault." if exists else "Create one master password to protect your local vault.", wraplength=510).pack(anchor="w", pady=(0, 24))
        ttk.Label(card, text="Master password").pack(anchor="w")
        self.master = tk.StringVar()
        entry = ttk.Entry(card, textvariable=self.master, show="•")
        entry.pack(fill="x", pady=(6, 14))
        self.confirm = tk.StringVar()
        if not exists:
            ttk.Label(card, text="Confirm master password").pack(anchor="w")
            ttk.Entry(card, textvariable=self.confirm, show="•").pack(fill="x", pady=(6, 12))
            ttk.Label(card, text="At least 14 characters. There is no password reset or recovery.", style="Muted.TLabel", wraplength=510).pack(anchor="w", pady=(0, 12))
        self.login_button = ttk.Button(card, text="Unlock vault" if exists else "Create vault", style="Accent.TButton", command=self.authenticate)
        self.login_button.pack(fill="x", pady=(4, 12))
        ttk.Button(card, text="Choose vault location…", command=self.choose_vault).pack(anchor="w")
        self.login_status = tk.StringVar(value=notice)
        ttk.Label(card, textvariable=self.login_status, wraplength=510, foreground="#9a342e").pack(anchor="w", pady=12)
        ttk.Label(outer, text=f"LOCAL FILE  •  {self.vault.path}", style="Muted.TLabel", wraplength=950).pack(side="bottom", anchor="w")
        self.root.bind("<Return>", lambda e: self.authenticate())
        entry.focus_set()

    def choose_vault(self):
        choice = filedialog.asksaveasfilename(parent=self.root, title="Choose an existing vault or name a new one", defaultextension=".vault", filetypes=[("QuietVault", "*.vault")], confirmoverwrite=False)
        if choice:
            self.master.set("")
            self.confirm.set("")
            self.vault = Vault(Path(choice))
            self.show_login()

    def authenticate(self):
        if self.vault.unlocked:
            return
        if time.monotonic() < self.retry_after:
            self.login_status.set("Please wait a few seconds before trying again.")
            return
        password = self.master.get()
        if not self.vault.path.exists() and password != self.confirm.get():
            self.login_status.set("The master passwords do not match.")
            return
        self.login_button.configure(state="disabled")
        self.login_status.set("Opening your vault…")
        self.root.update_idletasks()
        try:
            if self.vault.path.exists():
                self.vault.unlock(password)
            else:
                self.vault.create(password)
        except (VaultError, OSError) as exc:
            self.failed_attempts += 1
            self.retry_after = time.monotonic() + min(self.failed_attempts * 2, 10)
            self.login_status.set(str(exc) if isinstance(exc, VaultError) else "Cannot access the vault file. Check its location and permissions.")
            self.master.set("")
            self.confirm.set("")
            self.login_button.configure(state="normal")
            return
        finally:
            password = None
        self.master.set("")
        self.confirm.set("")
        self.failed_attempts = 0
        self.last_activity = time.monotonic()
        self.show_vault()

    def show_vault(self):
        self.clear_view()
        self.root.title("QuietVault — Unlocked")
        shell = ttk.Frame(self.root, padding=24)
        shell.pack(fill="both", expand=True)
        header = ttk.Frame(shell)
        header.pack(fill="x", pady=(0, 22))
        ttk.Label(header, text="Your vault", style="Title.TLabel").pack(side="left")
        ttk.Button(header, text="Lock / Log out", command=self.lock).pack(side="right")
        ttk.Button(header, text="Encrypted backup…", command=self.backup).pack(side="right", padx=10)
        ttk.Label(shell, text="Stored on this device  •  Auto-lock after 5 minutes of inactivity", style="Muted.TLabel").pack(anchor="w", pady=(0, 18))
        body = ttk.Frame(shell)
        body.pack(fill="both", expand=True)
        body.columnconfigure(0, weight=2)
        body.columnconfigure(1, weight=3)
        body.rowconfigure(0, weight=1)
        left = ttk.Frame(body, padding=(0, 0, 22, 0))
        left.grid(row=0, column=0, sticky="nsew")
        ttk.Label(left, text="Find a login", style="Heading.TLabel").pack(anchor="w", pady=(0, 10))
        self.search = tk.StringVar()
        ttk.Entry(left, textvariable=self.search).pack(fill="x", pady=(0, 12))
        self.search.trace_add("write", lambda *a: self.refresh())
        list_frame = ttk.Frame(left)
        list_frame.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(list_frame, columns=("title", "username"), show="headings", selectmode="browse")
        self.tree.heading("title", text="Account")
        self.tree.heading("username", text="Username")
        self.tree.column("title", width=160, minwidth=100)
        self.tree.column("username", width=140, minwidth=80)
        scrollbar = ttk.Scrollbar(list_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side="right", fill="y")
        self.tree.pack(fill="both", expand=True)
        self.tree.bind("<<TreeviewSelect>>", self.select)
        self.count = tk.StringVar()
        ttk.Label(left, textvariable=self.count, style="Muted.TLabel").pack(anchor="w", pady=10)
        ttk.Button(left, text="+ Add new entry", style="Accent.TButton", command=self.new).pack(fill="x")
        right = ttk.Frame(body)
        right.grid(row=0, column=1, sticky="nsew")
        self.editor_title = tk.StringVar(value="New entry")
        ttk.Label(right, textvariable=self.editor_title, style="Heading.TLabel").pack(anchor="w", pady=(0, 12))
        self.values = {field: tk.StringVar() for field in FIELDS if field != "notes"}
        for field, label in (("title", "Account name *"), ("username", "Username or email"), ("password", "Password *"), ("website", "Website")):
            ttk.Label(right, text=label).pack(anchor="w", pady=(6, 4))
            entry = ttk.Entry(right, textvariable=self.values[field], show="•" if field == "password" else "")
            entry.pack(fill="x")
            if field == "password":
                self.password_entry = entry
                actions = ttk.Frame(right)
                actions.pack(fill="x", pady=5)
                self.reveal = tk.BooleanVar(value=False)
                ttk.Checkbutton(actions, text="Show", variable=self.reveal, command=self.toggle_password).pack(side="left")
                ttk.Button(actions, text="Copy", command=self.copy_password).pack(side="right")
                ttk.Button(actions, text="Generate", command=self.generate).pack(side="right", padx=6)
            self.values[field].trace_add("write", self.mark_dirty)
        ttk.Label(right, text="Notes",).pack(anchor="w", pady=(12, 4))
        self.notes = tk.Text(right, height=4, wrap="word", font=("Helvetica", 12), relief="solid", borderwidth=1, highlightthickness=0)
        self.notes.pack(fill="both", expand=True)
        self.notes.bind("<<Modified>>", self.notes_modified)
        controls = ttk.Frame(right)
        controls.pack(fill="x", pady=(14, 0))
        ttk.Button(controls, text="Save entry", style="Accent.TButton", command=self.save).pack(side="right")
        ttk.Button(controls, text="Delete", command=self.delete).pack(side="left")
        ttk.Button(controls, text="Discard changes", command=self.discard).pack(side="left", padx=6)
        self.status = tk.StringVar(value="Add your first account to get started.")
        ttk.Label(shell, textvariable=self.status, wraplength=950, style="Muted.TLabel").pack(anchor="w", pady=(18, 0))
        self.selected = None
        self.dirty = False
        self.refresh()

    def refresh(self):
        if not self.vault.unlocked:
            return
        self.tree.delete(*self.tree.get_children())
        entries = self.vault.entries(self.search.get())
        for e in entries:
            self.tree.insert("", "end", iid=e["id"], values=(e["title"], e["username"]))
        self.count.set(f"{len(entries)} matching entries" if self.search.get() else f"{len(entries)} saved entries")

    def mark_dirty(self, *args):
        if not self.loading:
            self.dirty = True
            self.status.set("Unsaved changes — choose Save entry to keep them.")

    def notes_modified(self, event=None):
        if self.notes.edit_modified():
            self.mark_dirty()
            self.notes.edit_modified(False)

    def allow_discard(self):
        if not self.dirty:
            return True
        answer = messagebox.askyesno("Discard changes?", "This entry has unsaved changes. Discard them?", parent=self.root)
        return answer and self.vault.unlocked

    def load(self, entry=None):
        self.loading = True
        self.selected = entry["id"] if entry else None
        for field, var in self.values.items():
            var.set(entry[field] if entry else "")
        self.notes.delete("1.0", "end")
        self.notes.insert("1.0", entry["notes"] if entry else "")
        self.notes.edit_modified(False)
        self.reveal.set(False)
        self.toggle_password()
        self.editor_title.set("Edit entry" if entry else "New entry")
        self.loading = False
        self.dirty = False
        self.status.set("Entry loaded. Password hidden." if entry else "Ready for a new entry.")

    def select(self, event=None):
        if not self.vault.unlocked or not self.tree.selection():
            return
        key = self.tree.selection()[0]
        if key == self.selected:
            return
        if not self.allow_discard():
            if self.vault.unlocked:
                self.tree.selection_remove(*self.tree.selection())
            return
        entry = next((e for e in self.vault.entries() if e["id"] == key), None)
        if entry:
            self.load(entry)

    def new(self):
        if self.vault.unlocked and self.allow_discard():
            self.tree.selection_remove(*self.tree.selection())
            self.load()

    def discard(self):
        if self.vault.unlocked and self.allow_discard():
            self.load(next((e for e in self.vault.entries() if e["id"] == self.selected), None))

    def toggle_password(self):
        self.password_entry.configure(show="" if self.reveal.get() else "•")

    def generate(self):
        if self.values["password"].get():
            if not messagebox.askyesno("Replace password?", "Generate a new password in this form? Save to keep it. This does not change the website password.", parent=self.root):
                return
        if self.vault.unlocked:
            self.values["password"].set(generate_password())
            self.reveal.set(False)
            self.toggle_password()

    def save(self):
        if not self.vault.unlocked:
            return
        values = {field: var.get() for field, var in self.values.items()}
        values["notes"] = self.notes.get("1.0", "end-1c")
        if not values["title"].strip() or not values["password"]:
            messagebox.showerror("Required fields", "Enter an account name and password.", parent=self.root)
            return
        try:
            self.selected = self.vault.save_entry(values, self.selected)
        except (VaultError, OSError) as exc:
            self.error(exc)
            return
        self.dirty = False
        self.editor_title.set("Edit entry")
        self.refresh()
        self.status.set("Saved securely to your local vault.")

    def delete(self):
        if not self.vault.unlocked or not self.selected:
            return
        if not messagebox.askyesno("Delete entry?", "Permanently delete this saved entry? There is no undo.", parent=self.root):
            return
        if not self.vault.unlocked:
            return
        try:
            self.vault.delete_entry(self.selected)
        except (VaultError, OSError) as exc:
            self.error(exc)
            return
        self.clear_clipboard()
        self.load()
        self.refresh()
        self.status.set("Entry deleted from this vault. Existing backups are unchanged.")

    def copy_password(self):
        value = self.values["password"].get()
        if not value:
            return
        self.clear_clipboard()
        self.root.clipboard_clear()
        self.root.clipboard_append(value)
        self.copied = value
        self.clipboard_job = self.root.after(CLIPBOARD_SECONDS * 1000, self.clear_clipboard)
        self.status.set("Password copied. Clipboard cleanup is attempted in 30 seconds.")

    def clear_clipboard(self):
        if self.clipboard_job:
            self.root.after_cancel(self.clipboard_job)
            self.clipboard_job = None
        if self.copied is not None:
            try:
                if self.root.clipboard_get() == self.copied:
                    self.root.clipboard_clear()
            except tk.TclError:
                pass
        self.copied = None

    def backup(self):
        if self.dirty:
            messagebox.showinfo("Save first", "Save or discard your changes before making a backup.", parent=self.root)
            return
        name = filedialog.asksaveasfilename(parent=self.root, title="Save encrypted backup to a new file", defaultextension=".vault", initialfile=f"quietvault-backup-{time.strftime('%Y%m%d-%H%M%S')}.vault", filetypes=[("Encrypted vault", "*.vault")])
        if name and self.vault.unlocked:
            try:
                self.vault.backup(Path(name))
                self.status.set("Encrypted backup created. Keep its master password safe.")
            except (VaultError, OSError) as exc:
                self.error(exc)

    def error(self, exc):
        text = str(exc) if isinstance(exc, VaultError) else "File operation failed. Check available space, permissions, and whether the destination already exists. Your saved vault has not been intentionally replaced."
        messagebox.showerror("Could not complete action", text, parent=self.root)

    def lock(self, automatic=False):
        if not self.vault.unlocked:
            return
        if not automatic and not self.allow_discard():
            return
        self.clear_clipboard()
        for var in self.values.values():
            var.set("")
        self.notes.delete("1.0", "end")
        self.search.set("")
        self.vault.lock()
        self.selected = None
        self.dirty = False
        self.show_login("Automatically locked after inactivity. Unsaved changes were discarded." if automatic else "Vault locked. Saved entries are encrypted on disk.")

    def close(self):
        if self.vault.unlocked and not self.allow_discard():
            return
        self.clear_clipboard()
        self.vault.lock()
        self.root.destroy()


def main():
    parser = argparse.ArgumentParser(description="QuietVault native desktop password manager")
    parser.add_argument("--vault", type=Path, default=Path.home() / ".quietvault" / "passwords.vault", help="Path to an existing or new encrypted vault")
    args = parser.parse_args()
    root = tk.Tk()
    App(root, args.vault)
    root.mainloop()

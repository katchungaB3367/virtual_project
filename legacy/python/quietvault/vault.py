"""Encrypted persistence. No GUI dependencies or network access."""
from __future__ import annotations

import base64
import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import string
import tempfile
import uuid

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id

MAX_BYTES = 8 * 1024 * 1024
KDF = {"name": "argon2id", "iterations": 3, "lanes": 4, "memory_cost": 65536}
FIELDS = ("title", "username", "password", "website", "notes")


class VaultError(Exception):
    """An actionable error safe to display without secret data."""


def derive(password: str, salt: bytes) -> Fernet:
    key = Argon2id(salt=salt, length=32, iterations=3, lanes=4,
                   memory_cost=65536).derive(password.encode("utf-8"))
    return Fernet(base64.urlsafe_b64encode(key))


def generate_password(length: int = 24) -> str:
    if not 16 <= length <= 128:
        raise VaultError("Password length must be between 16 and 128.")
    groups = (string.ascii_lowercase, string.ascii_uppercase, string.digits, "!@#$%&*+-=?")
    alphabet = "".join(groups)
    while True:
        value = "".join(secrets.choice(alphabet) for _ in range(length))
        if all(any(c in group for c in value) for group in groups):
            return value


def validate_entries(entries):
    if not isinstance(entries, list) or len(entries) > 10000:
        raise VaultError("The vault contains an unsupported record list.")
    ids = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != set(FIELDS) | {"id", "updated"}:
            raise VaultError("The vault contains an invalid record.")
        if any(not isinstance(v, str) for v in entry.values()):
            raise VaultError("The vault contains invalid field values.")
        if any(len(entry[k]) > (10000 if k == "notes" else 1000) for k in FIELDS):
            raise VaultError("A field exceeds its supported size.")
        if not entry["title"].strip() or not entry["password"] or entry["id"] in ids:
            raise VaultError("The vault contains an invalid or duplicate record.")
        ids.add(entry["id"])


class Vault:
    def __init__(self, path: Path):
        self.path = Path(path).expanduser().absolute()
        self._cipher = None
        self._salt = None
        self._entries = []
        self._snapshot = None
        self._lock_file = None

    @property
    def unlocked(self):
        return self._cipher is not None

    def _acquire(self):
        """Hold an OS lock for the whole unlocked session; released after crashes."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(str(self.path) + ".lock", "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                handle.seek(0)
                if not handle.read(1):
                    handle.write(b"0")
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            handle.close()
            raise VaultError("This vault is open in another window. Lock that window first.") from exc
        self._lock_file = handle

    def lock(self):
        self._cipher = None
        self._salt = None
        self._entries = []
        self._snapshot = None
        if self._lock_file:
            self._lock_file.close()
            self._lock_file = None

    def _read(self):
        with self.path.open("rb") as handle:
            raw = handle.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise VaultError("The vault exceeds the 8 MiB file limit.")
        return raw

    def create(self, password: str):
        if self.unlocked:
            raise VaultError("Lock the current session first.")
        if len(password) < 14 or not password.strip():
            raise VaultError("Use a master password of at least 14 characters.")
        if len(password) > 1000:
            raise VaultError("The master password cannot exceed 1,000 characters.")
        self._acquire()
        try:
            if self.path.exists():
                raise VaultError("A vault already exists here. Unlock it instead.")
            self._salt = secrets.token_bytes(16)
            self._cipher = derive(password, self._salt)
            self._commit([])
        except Exception:
            self.lock()
            raise

    def unlock(self, password: str):
        if self.unlocked:
            raise VaultError("The vault is already unlocked.")
        if len(password) > 1000:
            raise VaultError("The master password cannot exceed 1,000 characters.")
        self._acquire()
        try:
            raw = self._read()
            envelope = json.loads(raw)
            if (not isinstance(envelope, dict) or envelope.get("version") != 1
                    or envelope.get("kdf") != KDF):
                raise VaultError("Unsupported vault format or key settings.")
            salt = base64.b64decode(envelope["salt"], validate=True)
            if len(salt) != 16:
                raise ValueError("salt")
            cipher = derive(password, salt)
            payload = json.loads(cipher.decrypt(envelope["token"].encode("ascii")))
            if not isinstance(payload, dict) or set(payload) != {"entries"}:
                raise ValueError("payload")
            validate_entries(payload["entries"])
            self._cipher, self._salt = cipher, salt
            self._entries, self._snapshot = payload["entries"], raw
        except (InvalidToken, ValueError, KeyError, TypeError, AttributeError, UnicodeError) as exc:
            self.lock()
            raise VaultError("Cannot unlock: incorrect master password or damaged vault.") from exc
        except Exception:
            self.lock()
            raise

    def _require(self):
        if not self.unlocked:
            raise VaultError("Unlock your vault first.")

    def entries(self, query=""):
        self._require()
        query = query.casefold().strip()
        return copy.deepcopy(sorted(
            (e for e in self._entries if query in " ".join(e[k] for k in ("title", "username", "website")).casefold()),
            key=lambda e: (e["title"].casefold(), e["id"])))

    def save_entry(self, values: dict, entry_id=None):
        self._require()
        if set(values) != set(FIELDS) or any(not isinstance(v, str) for v in values.values()):
            raise VaultError("Supply the five supported text fields.")
        entries = copy.deepcopy(self._entries)
        entry = dict(values)
        entry["title"] = entry["title"].strip()
        entry["id"] = entry_id or str(uuid.uuid4())
        entry["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if entry_id:
            index = next((i for i, e in enumerate(entries) if e["id"] == entry_id), None)
            if index is None:
                raise VaultError("That entry no longer exists.")
            entries[index] = entry
        else:
            entries.append(entry)
        validate_entries(entries)
        self._commit(entries)
        return entry["id"]

    def delete_entry(self, entry_id):
        self._require()
        entries = [e for e in self._entries if e["id"] != entry_id]
        if len(entries) == len(self._entries):
            raise VaultError("That entry no longer exists.")
        self._commit(entries)

    def _commit(self, entries):
        self._require()
        payload = json.dumps({"entries": entries}, ensure_ascii=False).encode("utf-8")
        raw = json.dumps({"version": 1, "kdf": KDF,
                          "salt": base64.b64encode(self._salt).decode("ascii"),
                          "token": self._cipher.encrypt(payload).decode("ascii")}).encode("utf-8")
        if len(raw) > MAX_BYTES:
            raise VaultError("The vault would exceed the 8 MiB file limit.")
        if self._snapshot is not None:
            if not self.path.exists() or self._read() != self._snapshot:
                raise VaultError("The vault changed outside this app. Lock and reopen it before editing.")
        fd, temporary = tempfile.mkstemp(prefix=".quietvault-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            if self._snapshot is None:
                # Exclusive creation: never replace an existing user's vault.
                os.link(temporary, self.path)
            else:
                os.replace(temporary, self.path)
            self._entries, self._snapshot = entries, raw
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def backup(self, destination: Path):
        self._require()
        destination = Path(destination).expanduser().absolute()
        if destination.resolve() == self.path.resolve():
            raise VaultError("Choose a different location from the active vault.")
        # Backup the authenticated snapshot, not potentially changed external bytes.
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(self._snapshot)
                handle.flush()
                os.fsync(handle.fileno())
        except Exception:
            destination.unlink(missing_ok=True)
            raise

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from quietvault.vault import Vault, VaultError, generate_password

MASTER = "a unique demo master passphrase"
ENTRY = dict(title="Example account", username="demo@example.test", password="NeverUseThisSecret42!", website="https://example.test", notes="Private demonstration note")


class VaultTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "test.vault"
        self.vault = Vault(self.path)
        self.vault.create(MASTER)

    def tearDown(self):
        self.vault.lock()
        self.temp.cleanup()

    def test_roundtrip_all_fields_encrypted(self):
        key = self.vault.save_entry(ENTRY)
        raw = self.path.read_text()
        for secret in [MASTER, *ENTRY.values()]:
            self.assertNotIn(secret, raw)
        self.vault.lock()
        self.vault.unlock(MASTER)
        entry = self.vault.entries()[0]
        self.assertEqual(key, entry["id"])
        for field in ENTRY:
            self.assertEqual(ENTRY[field], entry[field])

    def test_wrong_password_and_lock(self):
        self.vault.lock()
        with self.assertRaises(VaultError):
            self.vault.unlock("the wrong master password")
        self.assertFalse(self.vault.unlocked)
        with self.assertRaises(VaultError):
            self.vault.entries()
        self.vault.unlock(MASTER)

    def test_tampered_ciphertext_rejected(self):
        self.vault.lock()
        data = json.loads(self.path.read_text())
        token = data["token"]
        data["token"] = token[:25] + ("A" if token[25] != "A" else "B") + token[26:]
        self.path.write_text(json.dumps(data))
        with self.assertRaises(VaultError):
            self.vault.unlock(MASTER)
        self.assertFalse(self.vault.unlocked)

    def test_malformed_and_unbounded_kdf_rejected(self):
        self.vault.lock()
        raw = self.path.read_bytes()
        for data in (b"not json", b"[]", b'{}', b'{"version":1,"kdf":{"memory_cost":999999999}}'):
            self.path.write_bytes(data)
            with self.assertRaises(VaultError):
                self.vault.unlock(MASTER)
        self.path.write_bytes(raw)
        self.vault.unlock(MASTER)

    def test_edit_delete_and_search(self):
        key = self.vault.save_entry(ENTRY)
        self.assertEqual(1, len(self.vault.entries("EXAMPLE")))
        self.assertEqual([], self.vault.entries(ENTRY["password"]))
        self.vault.save_entry(dict(ENTRY, title="Updated"), key)
        self.assertEqual(1, len(self.vault.entries()))
        self.assertEqual("Updated", self.vault.entries()[0]["title"])
        self.vault.delete_entry(key)
        self.vault.lock()
        self.vault.unlock(MASTER)
        self.assertEqual([], self.vault.entries())

    def test_validation_preserves_file(self):
        original = self.path.read_bytes()
        for values in (dict(ENTRY, title="  "), dict(ENTRY, password=""), dict(ENTRY, notes="x" * 10001)):
            with self.assertRaises(VaultError):
                self.vault.save_entry(values)
        self.assertEqual(original, self.path.read_bytes())

    def test_unicode_and_password_whitespace_preserved(self):
        self.vault.save_entry(dict(ENTRY, title="日本語 café", password="  spaced 🔑  "))
        self.vault.lock()
        self.vault.unlock(MASTER)
        self.assertEqual("  spaced 🔑  ", self.vault.entries()[0]["password"])

    def test_backup_can_be_unlocked(self):
        self.vault.save_entry(ENTRY)
        backup = Path(self.temp.name) / "backup.vault"
        self.vault.backup(backup)
        other = Vault(backup)
        try:
            other.unlock(MASTER)
            self.assertEqual(self.vault.entries(), other.entries())
            with self.assertRaises(FileExistsError):
                self.vault.backup(backup)
        finally:
            other.lock()

    def test_failed_atomic_replace_preserves_saved_and_memory_data(self):
        key = self.vault.save_entry(ENTRY)
        before = self.path.read_bytes()
        with patch("quietvault.vault.os.replace", side_effect=OSError("disk failure")):
            with self.assertRaises(OSError):
                self.vault.save_entry(dict(ENTRY, title="Uncommitted"), key)
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual(ENTRY["title"], self.vault.entries()[0]["title"])
        self.assertEqual([], list(self.path.parent.glob(".quietvault-*")))

    def test_external_change_not_overwritten(self):
        self.path.write_bytes(b"external replacement")
        with self.assertRaises(VaultError):
            self.vault.save_entry(ENTRY)
        self.assertEqual(b"external replacement", self.path.read_bytes())

    def test_second_session_is_blocked(self):
        other = Vault(self.path)
        try:
            with self.assertRaises(VaultError):
                other.unlock(MASTER)
            self.vault.lock()
            other.unlock(MASTER)
        finally:
            other.lock()

    def test_create_never_overwrites_existing_file(self):
        before = self.path.read_bytes()
        self.vault.lock()
        with self.assertRaises(VaultError):
            self.vault.create(MASTER)
        self.assertEqual(before, self.path.read_bytes())

    def test_reject_short_master(self):
        self.vault.lock()
        other = Vault(Path(self.temp.name) / "new.vault")
        with self.assertRaises(VaultError):
            other.create("short")
        self.assertFalse(other.path.exists())

    def test_owner_only_file_permissions_on_posix(self):
        if os.name != "nt":
            self.assertEqual(0o600, self.path.stat().st_mode & 0o777)

    def test_returned_entries_cannot_mutate_vault(self):
        self.vault.save_entry(ENTRY)
        self.vault.entries()[0]["password"] = "changed"
        self.assertEqual(ENTRY["password"], self.vault.entries()[0]["password"])

    def test_random_generator(self):
        passwords = {generate_password() for _ in range(100)}
        self.assertEqual(100, len(passwords))
        for value in passwords:
            self.assertEqual(24, len(value))
            self.assertTrue(any(c.islower() for c in value))
            self.assertTrue(any(c.isupper() for c in value))
            self.assertTrue(any(c.isdigit() for c in value))
            self.assertTrue(any(c in "!@#$%&*+-=?" for c in value))
        with self.assertRaises(VaultError):
            generate_password(8)


if __name__ == "__main__":
    unittest.main()

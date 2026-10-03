"""Exercise timeout and clipboard decisions without a windowing server."""
import unittest
from unittest.mock import Mock, patch

from quietvault.app import App, IDLE_SECONDS


class SessionTests(unittest.TestCase):
    def app(self):
        app = App.__new__(App)
        app.root = Mock()
        app.vault = Mock(unlocked=True)
        app.lock = Mock()
        app.last_activity = 0
        return app

    def test_expired_activity_locks_before_reset(self):
        app = self.app()
        with patch("quietvault.app.time.monotonic", return_value=IDLE_SECONDS + 1):
            app.activity()
        app.lock.assert_called_once_with(automatic=True)

    def test_idle_tick_locks_and_reschedules(self):
        app = self.app()
        with patch("quietvault.app.time.monotonic", return_value=IDLE_SECONDS + 1):
            app.tick()
        app.lock.assert_called_once_with(automatic=True)
        app.root.after.assert_called_once_with(1000, app.tick)

    def test_clipboard_cleanup_preserves_other_content(self):
        app = self.app()
        app.copied = "test secret"
        app.clipboard_job = "timer"
        app.root.clipboard_get.return_value = "unrelated text"
        app.clear_clipboard()
        app.root.clipboard_clear.assert_not_called()
        app.root.after_cancel.assert_called_once_with("timer")
        self.assertIsNone(app.copied)

    def test_clipboard_cleanup_clears_own_content(self):
        app = self.app()
        app.copied = "test secret"
        app.clipboard_job = None
        app.root.clipboard_get.return_value = "test secret"
        app.clear_clipboard()
        app.root.clipboard_clear.assert_called_once()


if __name__ == "__main__":
    unittest.main()

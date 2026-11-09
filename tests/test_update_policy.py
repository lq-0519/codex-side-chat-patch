"""Validate the external CLI preference shared with the native application menu."""

from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from patchkit import manager, update_policy


class UpdatePolicy(unittest.TestCase):
    """Keep preference writes and CLI checks in disposable directories outside the repository."""

    def test_default_and_corrupt_settings_disable_updates(self):
        """Missing, malformed, wrong-version and nonboolean values must never imply consent."""
        with tempfile.TemporaryDirectory(prefix="codex-policy-cli-") as directory:
            state = Path(directory)
            self.assertFalse(update_policy.read_policy(state)["enabled"])
            for value in [None, {"version": True, "enabled": True}, {"version": 1, "enabled": "true"}]:
                (state / "update-policy.json").write_text(json.dumps(value))
                result = update_policy.read_policy(state)
                self.assertFalse(result["enabled"])
                self.assertIsNotNone(result["error"])

    def test_enable_disable_persist_private_shared_schema(self):
        """Explicit choices survive rereads with a 0600 preference and no temporary file."""
        with tempfile.TemporaryDirectory(prefix="codex-policy-cli-") as directory:
            state = Path(directory)
            self.assertTrue(update_policy.set_policy(state, True)["enabled"])
            self.assertFalse(update_policy.set_policy(state, False)["enabled"])
            path = state / "update-policy.json"
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), {"version": 1, "enabled": False})
            self.assertEqual(list(state.iterdir()), [path])

    def test_failed_replace_preserves_previous_choice(self):
        """Atomic write failure leaves prior consent readable and cleans the pending file."""
        with tempfile.TemporaryDirectory(prefix="codex-policy-cli-") as directory:
            state = Path(directory)
            update_policy.set_policy(state, True)
            with patch.object(update_policy.os, "replace", side_effect=OSError("synthetic failure")):
                with self.assertRaises(OSError):
                    update_policy.set_policy(state, False)
            self.assertTrue(update_policy.read_policy(state)["enabled"])
            self.assertEqual(len(list(state.iterdir())), 1)

    def test_cli_never_inspects_or_launches_the_app(self):
        """Preference-only commands must not call app inspection, installation or subprocesses."""
        with tempfile.TemporaryDirectory(prefix="codex-policy-cli-") as directory:
            with patch.object(manager, "inspect", side_effect=AssertionError("app access")), \
                    patch.object(manager, "run", side_effect=AssertionError("subprocess")):
                for action, expected in [("status", False), ("enable", True), ("disable", False)]:
                    output = io.StringIO()
                    with redirect_stdout(output):
                        self.assertEqual(manager.main(["--state-dir", directory, "updates", action]), 0)
                    result = json.loads(output.getvalue())
                    self.assertEqual(result["enabled"], expected)
                    self.assertEqual(result["takes_effect"], "next-launch")

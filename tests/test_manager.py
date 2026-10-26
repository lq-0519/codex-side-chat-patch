"""Exercise real file exchanges with synthetic bundles; production installs are never modified."""

import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

from patchkit import archive, manager


class BundleTransactions(unittest.TestCase):
    """Validate complete-bundle rollback, interruption recovery and overwrite refusal on disk."""

    def setUp(self):
        """Create independent original and staged app trees entirely outside the repository."""
        self.temporary = tempfile.TemporaryDirectory(prefix="codex-patch-transaction-")
        self.root = Path(self.temporary.name).resolve()
        self.app = self.root / "Original.app"
        self.stage = self.root / "stage"
        self.staged = self.stage / "Original.app"
        self.state = self.root / "state"
        self.original_hash = archive.sha256_bytes(b"original-archive")
        self.patched_hash = archive.sha256_bytes(b"patched-archive")
        for app, kind in ((self.app, "original"), (self.staged, "patched")):
            resources = app / "Contents/Resources"
            resources.mkdir(parents=True)
            (resources / "app.asar").write_bytes((kind + "-archive").encode())
            (resources / "whole-bundle-marker").write_text(kind)
            (app / "Contents/Info.plist").write_bytes(plistlib.dumps({"kind": kind}))
        self.receipt = {
            "signing_identity": "a" * 40,
            "source": {"asar_sha256": self.original_hash},
            "patched_asar_sha256": self.patched_hash,
        }
        self.patches = [
            patch.object(manager, "verify_stage", return_value=(self.staged, self.receipt)),
            patch.object(manager, "inspect", side_effect=self.inspect_fixture),
            patch.object(manager, "require_stopped"),
            patch.object(manager, "verify_signature"),
            patch.dict(manager.PROFILE, {"asar_sha256": self.original_hash}),
        ]
        for mock in self.patches:
            mock.start()

    def tearDown(self):
        """Release mocks before removing only this test's external temporary bundle trees."""
        for mock in reversed(self.patches):
            mock.stop()
        self.temporary.cleanup()

    def inspect_fixture(self, app):
        """Model verified identities from physical archive content, leaving exchanges real."""
        digest = archive.sha256_file(manager.archive_path(app))
        return {
            "state": {self.original_hash: "original", self.patched_hash: "patched"}.get(digest, "unknown"),
            "asar_sha256": digest,
        }

    def test_apply_idempotence_and_full_rollback(self):
        """A repeated apply must preserve its backup and rollback must restore all original resources."""
        applied = manager.apply(self.app, self.stage, self.state)
        backup = Path(applied["backup"])
        self.assertEqual((backup / "Contents/Resources/whole-bundle-marker").read_text(), "original")
        repeated = manager.apply(self.app, self.stage, self.state)
        self.assertEqual(repeated["state"], "already-patched")
        rolled_back = manager.rollback(self.app, self.state)
        self.assertEqual(rolled_back["state"], "rolled-back")
        self.assertEqual((self.app / "Contents/Resources/whole-bundle-marker").read_text(), "original")
        self.assertEqual(plistlib.loads((self.app / "Contents/Info.plist").read_bytes())["kind"], "original")
        self.assertEqual(manager.rollback(self.app, self.state)["state"], "already-original")

    def test_unknown_and_running_app_do_not_write(self):
        """Both an unknown update and an active process must prevent replacement before copying."""
        manager.archive_path(self.app).write_bytes(b"unknown-update")
        with self.assertRaisesRegex(ValueError, "refusing"):
            manager.apply(self.app, self.stage, self.state)
        self.assertEqual(manager.archive_path(self.app).read_bytes(), b"unknown-update")
        manager.archive_path(self.app).write_bytes(b"original-archive")
        with patch.object(manager, "require_stopped", side_effect=ValueError("Application is running")):
            with self.assertRaisesRegex(ValueError, "running"):
                manager.apply(self.app, self.stage, self.state)
        self.assertFalse((self.state / "installation.json").exists())

    def test_post_exchange_failure_restores_original(self):
        """A failed installed-bundle check must revert the real atomic exchange automatically."""
        def verify(app):
            if Path(app) == self.app and manager.archive_path(app).read_bytes() == b"patched-archive":
                raise ValueError("Post-exchange signature failure")
        with patch.object(manager, "verify_signature", side_effect=verify):
            with self.assertRaisesRegex(ValueError, "signature failure"):
                manager.apply(self.app, self.stage, self.state)
        self.assertEqual(manager.archive_path(self.app).read_bytes(), b"original-archive")
        self.assertEqual(json.loads((self.state / "transaction.json").read_text())["status"], "reverted")

    def test_interrupted_receipt_commit_is_recoverable(self):
        """A crash after bundle exchange but before receipt commit must leave an actionable journal."""
        with patch.object(manager, "commit_exchange", side_effect=OSError("simulated crash")):
            with self.assertRaisesRegex(OSError, "simulated crash"):
                manager.apply(self.app, self.stage, self.state)
        self.assertEqual(manager.archive_path(self.app).read_bytes(), b"patched-archive")
        with self.assertRaisesRegex(ValueError, "interrupted"):
            manager.apply(self.app, self.stage, self.state)
        self.assertEqual(manager.recover(self.state)["state"], "recovered")
        self.assertEqual(manager.archive_path(self.app).read_bytes(), b"original-archive")
        self.assertFalse((self.state / "installation.json").exists())

    def test_rollback_refuses_an_external_update(self):
        """Rollback cannot clobber a newly updated application even when a valid backup remains."""
        manager.apply(self.app, self.stage, self.state)
        manager.archive_path(self.app).write_bytes(b"new-vendor-update")
        with self.assertRaisesRegex(ValueError, "changed after installation"):
            manager.rollback(self.app, self.state)
        self.assertEqual(manager.archive_path(self.app).read_bytes(), b"new-vendor-update")


class ArchiveIntegrity(unittest.TestCase):
    """Verify append-only packing, digest enforcement and untouched original file offsets."""

    def test_replace_add_roundtrip_and_corruption(self):
        """Changing one asset and adding a module must preserve unrelated bytes and detect tampering."""
        with tempfile.TemporaryDirectory(prefix="codex-patch-asar-") as root:
            path = Path(root) / "app.asar"
            first, second = b"original-one", b"untouched-two"
            def node(data, offset):
                """Build a compact valid integrity fixture with several small blocks."""
                return {
                    "size": len(data), "offset": str(offset),
                    "integrity": {"algorithm": "SHA256", "hash": archive.sha256_bytes(data),
                                  "blockSize": 4, "blocks": [
                                      archive.sha256_bytes(data[i:i + 4]) for i in range(0, len(data), 4)
                                  ]},
                }
            tree = {"files": {"assets": {"files": {
                "one.js": node(first, 0), "two.js": node(second, len(first)),
            }}}}
            prefix, _ = archive.serialize_header(tree)
            path.write_bytes(prefix + first + second)
            header_hash = archive.rebuild(path, {"assets/one.js": b"changed-one", "assets/new.mjs": b"new"})
            self.assertEqual(archive.read_file(path, "assets/one.js"), b"changed-one")
            self.assertEqual(archive.read_file(path, "assets/two.js"), second)
            self.assertEqual(archive.read_file(path, "assets/new.mjs"), b"new")
            updated, start, raw = archive.read_header(path)
            self.assertEqual(header_hash, archive.sha256_bytes(raw))
            self.assertEqual(archive.resolve(updated, "assets/two.js")["offset"], str(len(first)))
            with path.open("r+b") as stream:
                stream.seek(start + int(archive.resolve(updated, "assets/one.js")["offset"]))
                stream.write(b"X")
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                archive.read_file(path, "assets/one.js")


class StageIdentity(unittest.TestCase):
    """Reject a tampered receipt or the wrong real certificate before an install can be copied."""

    def verify_fixture(self, root, identity, signature, manifest_identity=None):
        """Write a receipt/plist pair while isolating only the macOS signature service."""
        root = Path(root)
        app = root / "Fixture.app"
        (app / "Contents/Resources").mkdir(parents=True, exist_ok=True)
        manager.archive_path(app).write_bytes(b"patched-fixture")
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            manager.STAMP_KEY: {
                "signing_identity": identity if manifest_identity is None else manifest_identity,
            },
        }))
        manager.atomic_json(root / "receipt.json", {
            "profile": manager.PROFILE["id"], "implementation": manager.implementation_digest(),
            "bundle_name": app.name, "signing_identity": identity,
            "patched_asar_sha256": archive.sha256_file(manager.archive_path(app)),
            "patched_assets": {}, "signature": signature,
        })
        with (
            patch.object(manager, "inspect", return_value={"state": "patched"}),
            patch.object(manager, "signature_description", return_value=signature),
        ):
            return manager.verify_stage(root)

    def test_adhoc_receipt_cannot_be_promoted_to_a_fixed_identity(self):
        """Changing either receipt alone or receipt and plist cannot turn ad-hoc code into a certificate."""
        with tempfile.TemporaryDirectory(prefix="codex-stage-identity-") as root:
            signature = {"CDHash": ["fixture"], "Signature": ["adhoc"]}
            self.verify_fixture(root, "-", signature)
            with self.assertRaisesRegex(ValueError, "signed manifest"):
                self.verify_fixture(root, "a" * 40, signature, manifest_identity="-")
            with self.assertRaisesRegex(ValueError, "fixed certificate"):
                self.verify_fixture(root, "a" * 40, signature)

    def test_actual_certificate_must_match_the_selected_sha1(self):
        """A signed stage must prove the actual leaf certificate matches the user's fixed identity."""
        with tempfile.TemporaryDirectory(prefix="codex-stage-identity-") as root:
            signature = {
                "CDHash": ["fixture"], "Authority": ["Local fixture signing"],
                "CertificateSHA1": ["A" * 40],
            }
            self.verify_fixture(root, "a" * 40, signature)
            with self.assertRaisesRegex(ValueError, "fixed certificate"):
                self.verify_fixture(root, "b" * 40, signature)


if __name__ == "__main__":
    unittest.main()

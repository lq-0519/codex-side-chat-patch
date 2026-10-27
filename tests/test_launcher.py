"""Exercise complete synthetic ASAR bundles and real swaps without opening any desktop UI."""

import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from patchkit import archive, launcher, manager


class AutomaticStartup(unittest.TestCase):
    """Check startup, update acceptance/refusal, cache freshness and transaction recovery on disk."""

    def setUp(self):
        """Build an unsigned miniature app; mock only signature/engine services and desktop actions."""
        self.temporary = tempfile.TemporaryDirectory(prefix="codex-side-launch-tests-")
        self.root = Path(self.temporary.name).resolve()
        self.app = self.root / "Codex Test.app"
        self.state = self.root / "state"
        self.identity = "A" * 40
        self.assets = {
            "webview/assets/" + name: ("globalThis.asset = " + str(index) + ";\n").encode()
            for index, name in enumerate(manager.ASSETS)
        }
        self.assets.update({
            name: b"globalThis.nativeMainAsset = true;\n" for name in manager.MAIN_ASSETS
        })
        self.assets["webview/assets/unrelated.js"] = b"globalThis.unrelated = 1;\n"
        self.write_app()
        self.original_hash = archive.sha256_file(manager.archive_path(self.app))
        self.real_run = manager.run
        self.real_subprocess = subprocess.run
        self.mocks = [
            patch.dict(manager.PROFILE, {"asar_sha256": self.original_hash}),
            patch.object(manager, "ASSETS", {
                Path(name).name: archive.sha256_bytes(data)
                for name, data in self.assets.items()
                if name.startswith("webview/assets/") and not name.endswith("unrelated.js")
            }),
            patch.object(manager, "MAIN_ASSETS", {
                name: archive.sha256_bytes(data)
                for name, data in self.assets.items() if name.startswith(".vite/")
            }),
            patch.object(manager, "build_replacements", side_effect=self.replacements),
            patch.object(manager, "verify_signature"),
            patch.object(manager, "signature_description", side_effect=self.signature),
            patch.object(manager, "verify_framework", return_value="f" * 64),
            patch.object(manager, "synchronize_framework"),
            patch.object(manager, "run", side_effect=self.run_service),
            patch.object(manager.subprocess, "run", side_effect=self.subprocess_service),
            patch.object(launcher, "open_application"),
            patch.object(launcher, "native_notice"),
        ]
        self.started = [mock.start() for mock in self.mocks]
        self.open_mock, self.notice_mock = self.started[-2:]

    def tearDown(self):
        """Stop service mocks and remove only this test's external temporary bundles."""
        for mock in reversed(self.mocks):
            mock.stop()
        self.temporary.cleanup()

    def write_app(self):
        """Pack integrity-protected JS into a real ASAR and include separately sealed resources."""
        resources = self.app / "Contents/Resources"
        resources.mkdir(parents=True)
        (self.app / "Contents/MacOS").mkdir()
        (self.app / "Contents/MacOS/Test").write_text("synthetic executable\n")
        (resources / "engine-version.txt").write_text("codex-cli " + manager.PROFILE["cli_version"])
        (resources / "outside-asar.txt").write_text("original-resource")
        tree, payload = {"files": {}}, b""
        for name, data in self.assets.items():
            node = tree
            parts = name.split("/")
            for part in parts[:-1]:
                node = node["files"].setdefault(part, {"files": {}})
            node["files"][parts[-1]] = {
                "size": len(data), "offset": str(len(payload)),
                "integrity": {
                    "algorithm": "SHA256", "hash": archive.sha256_bytes(data),
                    "blockSize": 4096, "blocks": [archive.sha256_bytes(data)],
                },
            }
            payload += data
        header, raw = archive.serialize_header(tree)
        manager.archive_path(self.app).write_bytes(header + payload)
        self.write_plist({
            "CFBundleIdentifier": manager.PROFILE["bundle_id"], "CFBundleExecutable": "Test",
            "CFBundleShortVersionString": manager.PROFILE["version"],
            "CFBundleVersion": manager.PROFILE["build"],
            "ElectronAsarIntegrity": {"Resources/app.asar": {"hash": archive.sha256_bytes(raw)}},
        })

    def write_plist(self, info):
        """Persist fixture manifests with the same binary encoder used for staged applications."""
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps(info))

    def replacements(self, path):
        """Generate harmless valid JS after production inspection has checked the exact source assets."""
        return {
            name: data + b"globalThis.patchEnabled = true;\n"
            for name, data in self.assets.items() if not name.endswith("unrelated.js")
        }

    def signature(self, app):
        """Model a complete resource seal and certificate using all on-disk fixture bytes."""
        app = Path(app)
        digest = hashlib.sha256()
        for path in sorted(app.rglob("*")):
            if path.is_file():
                digest.update(str(path.relative_to(app)).encode())
                digest.update(path.read_bytes())
        stamp = manager.plist(app).get(manager.STAMP_KEY)
        if stamp is None:
            return {"CDHash": [digest.hexdigest()], "TeamIdentifier": ["2DC432GLL2"]}
        if stamp["signing_identity"] == "-":
            return {"CDHash": [digest.hexdigest()], "Signature": ["adhoc"]}
        return {
            "CDHash": [digest.hexdigest()], "Authority": ["Synthetic local identity"],
            "CertificateSHA1": [stamp["signing_identity"].upper()],
        }

    def run_service(self, arguments):
        """Keep copies, Node checks and process reads real, with no signing prompts or native UI."""
        if arguments[0] == "/usr/bin/codesign":
            return ""
        if str(arguments[0]).endswith("/codex-cli/bin/codex"):
            app = Path(arguments[0]).parents[4]
            return (app / "Contents/Resources/engine-version.txt").read_text()
        return self.real_run(arguments)

    def subprocess_service(self, arguments, **kwargs):
        """Provide source entitlements while forwarding unrelated subprocesses to the real OS."""
        if arguments[:3] == ["/usr/bin/codesign", "-d", "--entitlements"]:
            return subprocess.CompletedProcess(arguments, 0, plistlib.dumps({
                "test.entitlement": True, "com.apple.security.cs.allow-jit": True,
                "com.apple.developer.aps-environment": "production",
                "com.apple.developer.usernotifications.communication": True,
                "com.apple.developer.team-identifier": "2DC432GLL2",
                "keychain-access-groups": ["2DC432GLL2.com.openai.codex"],
            }), b"")
        return self.real_subprocess(arguments, **kwargs)

    def start(self, notify=True):
        """Invoke startup against the synthetic target; desktop open/notice calls remain mocked."""
        return launcher.launch(self.app, self.state, self.identity, notify=notify)

    def restore_vendor(self):
        """Model a same-version reinstall by copying the preserved full original to the target."""
        installation = json.loads((self.state / "installation.json").read_text())
        shutil.rmtree(self.app)
        shutil.copytree(installation["backup"], self.app)

    def update(self, target_change=False):
        """Model a vendor update with new version labels and either unrelated or changed target JS."""
        path = next(iter(self.assets)) if target_change else "webview/assets/unrelated.js"
        header = archive.rebuild(manager.archive_path(self.app), {path: b"globalThis.updated = true;\n"})
        info = manager.plist(self.app)
        info["CFBundleVersion"] = "99999"
        info["CFBundleShortVersionString"] = "99.0"
        info["ElectronAsarIntegrity"]["Resources/app.asar"]["hash"] = header
        self.write_plist(info)
        return archive.sha256_file(manager.archive_path(self.app))

    def test_apply_reinstall_cache_and_original_restore(self):
        """Startup installs once, skips an existing patch and reuses only the same verified source."""
        with patch.object(manager, "stage", wraps=manager.stage) as staging:
            first = self.start()
            self.assertEqual(first["patch_state"], "applied", first)
            self.assertFalse(first["stage_cache_reused"])
            self.assertEqual(self.start()["patch_state"], "already-patched")
            self.restore_vendor()
            repeated = self.start()
            self.assertEqual(repeated["patch_state"], "applied", repeated)
            self.assertTrue(repeated["stage_cache_reused"])
            self.assertEqual(staging.call_count, 1)
        self.assertEqual(manager.rollback(self.app, self.state)["state"], "rolled-back")
        self.assertEqual(archive.sha256_file(manager.archive_path(self.app)), self.original_hash)
        self.assertEqual(self.open_mock.call_count, 3)
        self.notice_mock.assert_not_called()

    def test_staging_removes_provisioned_vendor_rights_and_keeps_jit(self):
        """Prevent the real taskgated launch failure while retaining the runtime's required JIT rights."""
        directory, _ = launcher.cached_stage(
            self.app, manager.inspect(self.app), self.state, self.identity, "node",
        )
        entitlements = plistlib.loads((directory / "signing-entitlements.plist").read_bytes())
        self.assertEqual(entitlements, {
            "test.entitlement": True, "com.apple.security.cs.allow-jit": True,
            "com.apple.security.cs.disable-library-validation": True,
        })
        self.open_mock.assert_not_called()

    def test_matched_update_is_opt_in_noticed_once_and_rolls_back_to_that_update(self):
        """A structurally matched update is applied with a notice and never rolled back to an older build."""
        updated_hash = self.update()
        self.assertEqual(manager.inspect(self.app)["state"], "unknown")
        first = self.start()
        self.assertEqual(first["patch_state"], "applied", first)
        self.assertTrue(first["updated_version"])
        self.assertIn("可能有问题", first["warning"])
        stage = next((self.state / "stages").iterdir())
        with self.assertRaisesRegex(ValueError, "current patch"):
            manager.verify_stage(stage)
        manager.verify_stage(stage, allow_updated_version=True)
        self.assertEqual(self.start()["patch_state"], "already-patched")
        self.assertEqual(self.notice_mock.call_count, 1)
        manager.rollback(self.app, self.state)
        self.assertEqual(archive.sha256_file(manager.archive_path(self.app)), updated_hash)
        self.assertEqual(manager.plist(self.app)["CFBundleVersion"], "99999")
        self.assertEqual(manager.rollback(self.app, self.state)["state"], "already-original")

    def test_changed_target_update_is_retained_and_opened_without_patching(self):
        """Changed target code must stop before copying, while the unchanged current app is opened."""
        digest = self.update(target_change=True)
        with patch.object(manager, "stage", wraps=manager.stage) as staging:
            result = self.start()
            self.assertEqual(result["patch_state"], "not-enabled", result)
            self.assertIn("Unknown original asset", result["error"])
            staging.assert_not_called()
        self.assertEqual(archive.sha256_file(manager.archive_path(self.app)), digest)
        self.assertFalse((self.state / "installation.json").exists())
        self.open_mock.assert_called_once_with(self.app)
        self.notice_mock.assert_called_once()

    def test_changed_engine_is_retained(self):
        """Even unchanged target assets cannot authorize running the adapter against a new engine."""
        self.update()
        (self.app / "Contents/Resources/engine-version.txt").write_text("codex-cli unsupported")
        result = self.start()
        self.assertEqual(result["patch_state"], "not-enabled", result)
        self.assertIn("Unrecognized bundled engine", result["error"])
        self.assertNotIn(manager.STAMP_KEY, manager.plist(self.app))
        self.open_mock.assert_called_once()

    def test_cache_cannot_downgrade_resources_outside_the_archive(self):
        """An identical ASAR with newly sealed external resources requires a fresh whole-app stage."""
        self.start()
        self.restore_vendor()
        marker = self.app / "Contents/Resources/outside-asar.txt"
        marker.write_text("new-release-resource")
        result = self.start()
        self.assertEqual(result["patch_state"], "applied", result)
        self.assertFalse(result["stage_cache_reused"])
        self.assertEqual(marker.read_text(), "new-release-resource")
        self.assertEqual(len(list((self.state / "stages").iterdir())), 2)

    def test_wrong_source_stage_cannot_overwrite_same_asar_repackage(self):
        """Manual apply also checks the original's full vendor seal, independent of cache key choice."""
        self.start()
        self.restore_vendor()
        directory = next((self.state / "stages").iterdir())
        marker = self.app / "Contents/Resources/outside-asar.txt"
        marker.write_text("external-vendor-update")
        with self.assertRaisesRegex(ValueError, "differently packaged"):
            manager.apply(self.app, directory, self.state)
        self.assertEqual(marker.read_text(), "external-vendor-update")
        self.assertNotIn(manager.STAMP_KEY, manager.plist(self.app))

    def test_source_resource_change_during_copy_prevents_exchange(self):
        """An updater changing an external resource during installation must prevent the final swap."""
        directory, _ = launcher.cached_stage(
            self.app, manager.inspect(self.app), self.state, self.identity, "node",
        )
        marker = self.app / "Contents/Resources/outside-asar.txt"
        def change_during_copy(arguments):
            """Change the vendor resource only after the installed candidate has finished copying."""
            value = self.run_service(arguments)
            if arguments[0] == "/usr/bin/ditto":
                marker.write_text("concurrent-vendor-update")
            return value
        with patch.object(manager, "run", side_effect=change_during_copy):
            with self.assertRaisesRegex(ValueError, "changed while preparing"):
                manager.apply(self.app, directory, self.state)
        self.assertEqual(marker.read_text(), "concurrent-vendor-update")
        self.assertNotIn(manager.STAMP_KEY, manager.plist(self.app))
        self.assertFalse((self.state / "transaction.json").exists())

    def test_tampered_cached_bundle_is_retained_and_rebuilt(self):
        """A changed full-bundle seal invalidates a cache; startup constructs a separate valid copy."""
        self.start()
        self.restore_vendor()
        directory = next((self.state / "stages").iterdir())
        marker = directory / self.app.name / "Contents/Resources/outside-asar.txt"
        marker.write_text("tampered-cache-resource")
        result = self.start()
        self.assertEqual(result["patch_state"], "applied", result)
        self.assertFalse(result["stage_cache_reused"])
        self.assertEqual(marker.read_text(), "tampered-cache-resource")
        self.assertEqual((self.app / "Contents/Resources/outside-asar.txt").read_text(), "original-resource")

    def test_running_and_concurrent_launch_do_not_apply(self):
        """Focus a running instance; a concurrent startup cannot open an app during an exchange."""
        with patch.object(manager, "running", return_value=["synthetic active process"]):
            self.assertEqual(self.start()["state"], "focused-running")
        self.open_mock.assert_called_once()
        self.open_mock.reset_mock()
        with manager.state_lock(self.state, name="launch.lock"):
            self.assertEqual(self.start()["state"], "launch-in-progress")
        self.open_mock.assert_not_called()
        self.assertFalse((self.state / "stages").exists())
        self.assertEqual(archive.sha256_file(manager.archive_path(self.app)), self.original_hash)

    def test_incomplete_apply_is_recovered_before_open(self):
        """A failed receipt commit is rolled back automatically before opening the original application."""
        with patch.object(manager, "commit_exchange", side_effect=OSError("synthetic interrupted commit")):
            result = self.start()
        self.assertEqual(result["patch_state"], "not-enabled", result)
        self.assertEqual(result["recovery"], "recovered")
        self.assertEqual(archive.sha256_file(manager.archive_path(self.app)), self.original_hash)
        self.assertEqual(json.loads((self.state / "transaction.json").read_text())["status"], "recovered")
        self.open_mock.assert_called_once()

    def test_existing_pending_apply_is_recovered_then_reapplied(self):
        """A startup after a previous crash recovers its journal and reuses the valid staged copy."""
        with patch.object(manager, "commit_exchange", side_effect=OSError("synthetic crash")):
            directory, _ = launcher.cached_stage(
                self.app, manager.inspect(self.app), self.state, self.identity, "node",
            )
            with self.assertRaises(OSError):
                manager.apply(self.app, directory, self.state)
        result = self.start()
        self.assertEqual(result["patch_state"], "applied", result)
        self.assertEqual(result["recovery"], "recovered")
        self.assertTrue(result["stage_cache_reused"])
        self.open_mock.assert_called_once()

    def test_unknown_change_during_pending_exchange_blocks_startup(self):
        """Unknown post-crash bytes must stop both recovery writes and opening, retaining the evidence."""
        with patch.object(manager, "commit_exchange", side_effect=OSError("synthetic crash")):
            directory, _ = launcher.cached_stage(
                self.app, manager.inspect(self.app), self.state, self.identity, "node",
            )
            with self.assertRaises(OSError):
                manager.apply(self.app, directory, self.state)
        manager.archive_path(self.app).write_bytes(b"unknown-external-change")
        result = self.start()
        self.assertEqual(result["state"], "blocked", result)
        self.assertEqual(manager.archive_path(self.app).read_bytes(), b"unknown-external-change")
        self.open_mock.assert_not_called()

    def test_older_patch_is_upgraded_via_its_verified_original(self):
        """Upgrade from a previous implementation through its receipt-bound original without losing data."""
        self.start()
        info = manager.plist(self.app)
        info[manager.STAMP_KEY]["implementation"] = "older-implementation"
        self.write_plist(info)
        self.assertEqual(manager.inspect(self.app)["state"], "older-patch")
        result = self.start()
        self.assertEqual(result["patch_state"], "applied", result)
        self.assertEqual(manager.inspect(self.app)["state"], "patched")
        manager.rollback(self.app, self.state)
        self.assertEqual(archive.sha256_file(manager.archive_path(self.app)), self.original_hash)

    def test_generated_launcher_pins_tools_and_does_not_open_or_patch(self):
        """A shell-safe launcher handles spaces/quotes in paths and has a distinct bundle identity."""
        output = self.root / "Review ' launcher.app"
        result = launcher.create_launcher(self.app, self.state, output, self.identity)
        self.assertFalse(result["target_modified"])
        self.assertTrue(Path(result["config"]["python"]).is_absolute())
        self.assertTrue(Path(result["config"]["node"]).is_absolute())
        self.assertNotEqual(manager.plist(output)["CFBundleIdentifier"], manager.PROFILE["bundle_id"])
        self.open_mock.assert_not_called()
        self.notice_mock.assert_not_called()
        self.assertNotIn(manager.STAMP_KEY, manager.plist(self.app))
        self.assertFalse(self.state.exists())
        with self.assertRaisesRegex(ValueError, "fixed signing"):
            launcher.create_launcher(self.app, self.state, self.root / "No.app", "-")
        with self.assertRaisesRegex(ValueError, "overlap"):
            launcher.launch(self.app, self.app / "state", self.identity)

    def test_missing_application_produces_a_notice_and_no_open(self):
        """A moved or deleted installation gives the GUI launcher an actionable recorded failure."""
        shutil.rmtree(self.app)
        result = self.start()
        self.assertEqual(result["state"], "blocked")
        self.notice_mock.assert_called_once()
        self.open_mock.assert_not_called()
        self.assertTrue((self.state / "launch.jsonl").exists())


class StartupHealth(unittest.TestCase):
    """Reject a successful open command when the application's main process fails immediately."""

    def test_main_process_must_be_stable_and_helpers_are_insufficient(self):
        """Use a controlled clock to exercise both successful startup and a helper-only failed launch."""
        # Capture the real function before AutomaticStartup's per-test desktop service mocks.
        app = Path("/Applications/Synthetic.app")
        executable = str(app / "Contents/MacOS/Synthetic")
        for processes, succeeds in [
            (["10 " + executable], True),
            (["11 " + str(app / "Contents/Resources/helper")], False),
        ]:
            clock = [0.0]
            def tick(duration):
                """Advance simulated startup time without sleeping or interacting with real applications."""
                clock[0] += duration
            with (
                patch.object(manager, "run") as request,
                patch.object(manager, "plist", return_value={"CFBundleExecutable": "Synthetic"}),
                patch.object(manager, "running", return_value=processes),
                patch.object(launcher.time, "monotonic", side_effect=lambda: clock[0]),
                patch.object(launcher.time, "sleep", side_effect=tick),
            ):
                if succeeds:
                    launcher.open_application(app)
                else:
                    with self.assertRaisesRegex(ValueError, "did not remain running"):
                        launcher.open_application(app)
                request.assert_called_once_with(["/usr/bin/open", str(app)])


if __name__ == "__main__":
    unittest.main()

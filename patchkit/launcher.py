"""Generate an opt-in launcher and reapply verified patches before opening the original app."""

import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import plistlib

from . import manager
from .archive import sha256_bytes
from .profile import PROFILE, ROOT, implementation_digest


# FAILURES are operational failures that can be reported without masking programming defects.
FAILURES = (ValueError, OSError, KeyError, subprocess.TimeoutExpired)


def fixed_identity(identity):
    """Require an existing certificate's public SHA-1; launch never creates or rotates identities."""
    if not isinstance(identity, str) or re.fullmatch(r"[A-Fa-f0-9]{40}", identity) is None:
        raise ValueError("launch requires a fixed signing certificate SHA-1; ad-hoc installation is refused")
    return identity.upper()


def executable_path(command):
    """Resolve a runnable tool to an absolute path suitable for Finder's minimal environment.

    Preserve an absolute tool symlink rather than pinning a versioned Homebrew cellar path.
    No command is run here, and missing tools are rejected before generating the launcher.
    """
    located = shutil.which(str(command))
    if located is None:
        raise ValueError("Required executable is unavailable: " + str(command))
    return str(Path(located).absolute())


def cached_stage(app, source, state, identity, node):
    """Reuse only a verified full bundle from this exact vendor source and selected certificate.

    Each cache key includes source version, engine, full vendor signature, original ASAR,
    adapter/templates and certificate. Incomplete or invalid cache entries are retained for
    diagnosis; a fresh unique directory is constructed instead of overwriting any bundle.
    """
    basis = {
        "source": manager.source_fingerprint(source), "bundle_name": Path(app).name,
        "implementation": implementation_digest(), "identity": identity,
    }
    key = sha256_bytes(json.dumps(basis, sort_keys=True).encode())
    stages = state / "stages"
    stages.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = stages / key
    if directory.exists():
        try:
            _, receipt = manager.verify_stage(directory, allow_updated_version=True)
            if (
                manager.source_fingerprint(receipt["source"]) == basis["source"] and
                receipt["signing_identity"].upper() == identity and
                receipt["bundle_name"] == Path(app).name
            ):
                return directory, True
        except FAILURES:
            pass
        # mkdtemp reserves a unique sibling; stage itself requires a nonexistent output.
        directory = Path(tempfile.mkdtemp(prefix=key + "-", dir=stages))
        directory.rmdir()
    manager.stage(app, directory, identity, allow_updated_version=True, node=node)
    return directory, False


def pending_transaction(state):
    """Read only an uncommitted exchange; completed journals do not trigger repeated recovery."""
    path = state / "transaction.json"
    if path.exists():
        journal = json.loads(path.read_text())
        if journal.get("status") == "prepared":
            return journal
    return None


def recover_for_app(app, state):
    """Automatically recover this app's interrupted exchange without touching another installation."""
    journal = pending_transaction(state)
    if journal is None:
        return None
    if journal.get("app") != str(app):
        raise ValueError("Pending transaction belongs to another application; use its state directory")
    return manager.recover(state)


def original_for_older_patch(app, state, current):
    """Find a receipt-bound original for upgrading an older patch without overwriting a vendor update."""
    installation = json.loads((state / "installation.json").read_text())
    if (
        installation.get("app") != str(app) or installation.get("status") != "applied" or
        installation["receipt"]["patched_asar_sha256"] != current.get("asar_sha256")
    ):
        raise ValueError("Older patch has no matching installation receipt")
    backup = Path(installation["backup"])
    source = manager.inspect(backup, allow_updated_version=True)
    expected = installation["receipt"]["source"]
    if source["state"] != "original" or source["asar_sha256"] != expected["asar_sha256"]:
        raise ValueError("Older patch has no verified original backup")
    if (
        expected.get("source_signature") is not None and
        manager.source_fingerprint(source) != manager.source_fingerprint(expected)
    ):
        raise ValueError("Older patch original vendor fingerprint changed")
    return backup, source


def open_application(app):
    """Ask LaunchServices to open/focus this path; never quit processes or alter startup settings."""
    manager.run(["/usr/bin/open", str(app)])


def native_notice(message):
    """Display a bounded native notification using an argument vector, without shell evaluation."""
    literal = message[:1400].replace("\\", "\\\\").replace('"', '\\"').replace("\r", " ").replace("\n", " ")
    manager.run([
        "/usr/bin/osascript", "-e",
        'display notification "' + literal + '" with title "Codex 侧边会话"',
    ])


def finish_launch(state, result, notify):
    """Record a JSON outcome and deliver each version/outcome notice at most once.

    Logs contain installation metadata and errors only, never conversation content. Notification
    failure does not undo a successful launch and is recorded so the same notice can be retried.
    """
    result["timestamp"] = int(time.time())
    with (state / "launch.jsonl").open("a") as stream:
        os.chmod(state / "launch.jsonl", 0o600)
        stream.write(json.dumps(result, ensure_ascii=False) + "\n")
    message = result.get("warning")
    if not notify or message is None:
        return result
    notices_path = state / "notices.json"
    try:
        notices = json.loads(notices_path.read_text()) if notices_path.exists() else {}
        key = sha256_bytes(json.dumps({
            "version": result.get("version"), "build": result.get("build"),
            "source_asar": result.get("source_asar_sha256"), "warning": message,
        }, sort_keys=True, ensure_ascii=False).encode())
        if key not in notices:
            native_notice(message)
            notices[key] = result["timestamp"]
            # Bound durable metadata, keeping the 32 most recent notice outcomes.
            notices = dict(sorted(notices.items(), key=lambda pair: pair[1])[-32:])
            manager.atomic_json(notices_path, notices)
    except FAILURES as error:
        result["notice_error"] = str(error)
        with (state / "launch.jsonl").open("a") as stream:
            stream.write(json.dumps({"notice_error": str(error)}, ensure_ascii=False) + "\n")
    return result


def launch_stopped(app, state, identity, node, notify):
    """Recover, prepare/reuse, apply and open, preserving unknown updates and unrecoverable journals."""
    # result describes the requested launch and separately reports whether persistence was enabled.
    result = {"app": str(app), "state": "launched", "patch_state": "not-enabled"}
    try:
        info = manager.plist(app)
        result.update({
            "version": info.get("CFBundleShortVersionString"), "build": info.get("CFBundleVersion"),
            "updated_version": (
                info.get("CFBundleShortVersionString") != PROFILE["version"] or
                info.get("CFBundleVersion") != PROFILE["build"]
            ),
        })
        recovered = recover_for_app(app, state)
        if recovered is not None:
            result["recovery"] = recovered["state"]
        current = manager.inspect(app, allow_updated_version=True)
        result.update({
            "version": current.get("version"), "build": current.get("build"),
            "source_asar_sha256": current.get("original_asar_sha256", current.get("asar_sha256")),
            "updated_version": current.get("updated_version", False),
        })
        if current["state"] == "patched":
            if current.get("signing_identity", "").upper() != identity:
                raise ValueError("Installed patch uses a different certificate; rollback before changing identity")
            result["patch_state"] = "already-patched"
        elif current["state"] in ("original", "older-patch"):
            source_app, source = (
                original_for_older_patch(app, state, current)
                if current["state"] == "older-patch" else (app, current)
            )
            result["source_asar_sha256"] = source["asar_sha256"]
            result["updated_version"] = source.get("updated_version", False)
            node = executable_path(node)
            directory, reused = cached_stage(source_app, source, state, identity, node)
            result["stage_cache_reused"] = reused
            if current["state"] == "older-patch":
                manager.rollback(app, state)
            applied = manager.apply(app, directory, state, allow_updated_version=True)
            result["patch_state"] = applied["state"]
        else:
            raise ValueError(current.get("reason", "Application has no compatible patch adapter"))
        if result["updated_version"]:
            result["warning"] = "Codex 版本已更新，已先应用侧边会话补丁；这一版尚未完成桌面验证，可能有问题。"
    except FAILURES as error:
        result["error"] = str(error)
        result["warning"] = (
            ("Codex 版本已更新；" if result.get("updated_version") else "") +
            "本次未应用侧边会话补丁，已保留当前应用。原因：" + str(error)[:1200]
        )
        # A failed receipt commit can leave a valid swapped bundle. Reconcile it before opening.
        try:
            recovered = recover_for_app(app, state)
            if recovered is not None:
                result["recovery"] = recovered["state"]
        except FAILURES as recovery_error:
            result["state"] = "blocked"
            result["recovery_error"] = str(recovery_error)
            result["warning"] = "Codex 补丁事务尚未恢复，已暂停启动。请查看 launch.jsonl 并执行 recover。"
            return finish_launch(state, result, notify)
    try:
        open_application(app)
    except FAILURES as error:
        result["state"] = "blocked"
        result["open_error"] = str(error)
        result["warning"] = "Codex 启动请求失败：" + str(error)[:1200]
    return finish_launch(state, result, notify)


def launch(app, state, identity, node="node", notify=True):
    """Serialize opt-in startup; focus an active app or patch a stopped app before opening it.

    An active instance is never quit or hot-patched. A simultaneous launcher returns immediately
    while the first owns launch.lock, avoiding an open request during bundle exchange.
    """
    app = Path(app).expanduser().resolve()
    state = manager.outside_repository(state)
    identity = fixed_identity(identity)
    if state == app or app in state.parents or state in app.parents:
        raise ValueError("Launcher state and target bundle paths must not overlap")
    try:
        with manager.state_lock(state, name="launch.lock"):
            try:
                if manager.plist(app).get("CFBundleIdentifier") != PROFILE["bundle_id"]:
                    raise ValueError("Unexpected application bundle identifier")
                if manager.running(app):
                    open_application(app)
                    return finish_launch(state, {
                        "state": "focused-running", "app": str(app),
                        "patch_state": "deferred-until-quit",
                    }, notify)
                return launch_stopped(app, state, identity, node, notify)
            except FAILURES as error:
                return finish_launch(state, {
                    "state": "blocked", "app": str(app), "error": str(error),
                    "warning": "Codex 自动启动失败：" + str(error)[:1200],
                }, notify)
    except BlockingIOError:
        return {"state": "launch-in-progress", "app": str(app)}


def create_launcher(app, state, output, identity, node="node"):
    """Create a reviewable separate .app; generation never patches or starts the target application.

    The shell wrapper pins Python, Node, repository, certificate and original installation path.
    Its own bundle identity is distinct from Codex, so it does not replace the original Dock icon
    or register as a chat client. Only using this opt-in entry invokes automatic patching.
    """
    app = Path(app).expanduser().resolve()
    state = manager.outside_repository(state)
    output = manager.outside_repository(output)
    identity = fixed_identity(identity)
    node = executable_path(node)
    python = executable_path(sys.executable)
    if output.suffix != ".app" or output.exists():
        raise ValueError("Launcher output must be a new .app outside the repository")
    if (
        app == output or app in output.parents or output in app.parents or
        output == state or output in state.parents or
        state == app or app in state.parents or state in app.parents
    ):
        raise ValueError("Launcher, state and target bundle paths must not overlap")
    info = manager.plist(app)
    if info.get("CFBundleIdentifier") != PROFILE["bundle_id"]:
        raise ValueError("Unexpected application bundle identifier")
    executable = output / "Contents/MacOS/codex-side-launcher"
    resources = output / "Contents/Resources"
    executable.parent.mkdir(parents=True, mode=0o755)
    resources.mkdir(mode=0o755)
    config = {
        "app": str(app), "state": str(state), "identity": identity,
        "python": python, "node": node, "manager": str(ROOT / "codex_side_patch.py"),
        "automatic_update_attempt": True,
    }
    (resources / "launcher-config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")
    arguments = [
        python, "-B", config["manager"], "--app", str(app), "--state-dir", str(state),
        "launch", "--identity", identity, "--node", node,
    ]
    executable.write_text(
        "#!/bin/sh\n"
        "# Launch only through the explicit manager; arguments never undergo shell interpolation.\n"
        "exec " + shlex.join(arguments) + "\n"
    )
    executable.chmod(0o755)
    manifest = {
        "CFBundleIdentifier": "local.codex-side-chat-launcher." + sha256_bytes(str(app).encode())[:12],
        "CFBundleName": "Codex Side Chats", "CFBundleDisplayName": "Codex Side Chats",
        "CFBundleExecutable": executable.name, "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "1.0", "CFBundleVersion": "1", "LSUIElement": True,
    }
    icon_name = info.get("CFBundleIconFile")
    if isinstance(icon_name, str) and Path(icon_name).name == icon_name:
        icon = app / "Contents/Resources" / icon_name
        if icon.suffix != ".icns":
            icon = icon.with_suffix(".icns")
        if icon.is_file():
            shutil.copy2(icon, resources / "app.icns")
            manifest["CFBundleIconFile"] = "app.icns"
    (output / "Contents/Info.plist").write_bytes(plistlib.dumps(manifest))
    # The launcher needs only an ad-hoc seal; the fixed certificate is reserved for target staging.
    manager.run(["/usr/bin/codesign", "--force", "--sign", "-", str(output)])
    manager.verify_signature(output)
    manager.run(["/bin/sh", "-n", str(executable)])
    return {"state": "launcher-created", "launcher": str(output), "config": config, "target_modified": False}

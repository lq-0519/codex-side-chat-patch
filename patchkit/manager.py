"""Stage, verify and transactionally install a checked patch outside the application."""

import argparse
from contextlib import contextmanager
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile
import time
import uuid

from .archive import read_file, read_header, rebuild, sha256_bytes, sha256_file
from .integrity import synchronize_framework, verify_framework
from .profile import ASSETS, MAIN_ASSETS, PROFILE, ROOT, build_replacements, implementation_digest


# DEFAULT_APP is inspected by default; apply, rollback and opt-in launch can write to it.
DEFAULT_APP = Path("/Applications/ChatGPT.app")
# DEFAULT_STATE survives app replacement and stores receipts, locks and the transaction journal.
DEFAULT_STATE = Path.home() / "Library/Application Support/CodexSideChatPatch"
# STAMP_KEY identifies the patched plist; independent receipts also pin every changed asset.
STAMP_KEY = "CodexNativeSidePatch"
# SHARED_RUNTIME is also used by Lark's independent MCP worker, outside the desktop app lifecycle.
SHARED_RUNTIME = Path("Contents/Resources/cua_node/bin/node_repl")
# MCP_WORKER and MCP_SERVICE identify the verified external owner; unknown consumers still block writes.
MCP_WORKER = "/Applications/Lark.app/Contents/XPCServices/McpService.xpc/Contents/Helpers/McpHelperWorker"
MCP_SERVICE = "/Applications/Lark.app/Contents/XPCServices/McpService.xpc/Contents/MacOS/McpService"


def run(arguments):
    """Execute an argument vector without shell interpolation and report actionable stderr."""
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise ValueError("Command failed: " + str(arguments[0]) + "\n" + result.stderr.strip())
    return result.stdout


def outside_repository(path):
    """Keep staging, extracted JS, receipts, caches and analysis output outside the code repository."""
    path = Path(path).expanduser().resolve()
    if path == ROOT or ROOT in path.parents:
        raise ValueError("Operational files must be outside the code repository")
    return path


def atomic_json(path, value):
    """Write an fsynced JSON journal/receipt with a same-directory atomic rename."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".temporary")
    with temporary.open("w") as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    sync_directory(path.parent)


def sync_directory(path):
    """Durably record bundle/journal renames on the containing filesystem."""
    descriptor = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def plist(app):
    """Read the bundle manifest without invoking or launching application UI."""
    return plistlib.loads((Path(app) / "Contents/Info.plist").read_bytes())


def archive_path(app):
    """Locate the single ASAR protected by this pinned application's Electron integrity fuse."""
    return Path(app) / "Contents/Resources/app.asar"


def running(app):
    """Detect real bundle executables, preserving Lark's independently owned unchanged Node runtime.

    Inspect executable paths rather than arbitrary command arguments. Only the exact shared Node
    executable with both known Lark MCP ancestors is excluded. Every desktop process, orphaned
    helper and unknown standalone consumer still prevents installation. Exchanges additionally
    require the shared runtime bytes to match, and preserve the original complete bundle/inodes.
    """
    app = Path(app).resolve()
    processes = {}
    for line in run(["/bin/ps", "-ww", "-axo", "pid=,ppid=,comm="]).splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) == 3 and fields[0].isdigit() and fields[1].isdigit():
            processes[int(fields[0])] = (int(fields[1]), fields[2])
    matches = []
    for pid, (parent, executable) in processes.items():
        if not executable.startswith(str(app) + "/"):
            continue
        owner = processes.get(parent)
        service = processes.get(owner[0]) if owner is not None else None
        if (
            executable == str(app / SHARED_RUNTIME) and owner is not None and service is not None and
            owner[1] == MCP_WORKER and service[1] == MCP_SERVICE
        ):
            continue
        matches.append(str(pid) + " " + executable)
    return matches


def require_unchanged_shared_runtime(app, candidate):
    """Protect independent MCP consumers by rejecting a replacement that changes their runtime bytes.

    An atomic whole-bundle exchange retains the running process's original inode in the backup.
    The path it may use for future launches must contain exactly the same executable bytes.
    Synthetic fixtures may omit this optional runtime on both sides, but never only one side.
    """
    original, replacement = Path(app) / SHARED_RUNTIME, Path(candidate) / SHARED_RUNTIME
    if not original.exists() and not replacement.exists():
        return
    if (
        not original.is_file() or not replacement.is_file() or
        sha256_file(original) != sha256_file(replacement)
    ):
        raise ValueError("Shared MCP runtime changed; this adapter requires an unchanged runtime")


def require_stopped(app):
    """Refuse hot patching or forced exits; the user keeps control of an in-use application."""
    if running(app):
        raise ValueError("Application is running; quit it before apply/rollback/recover")


def verify_signature(app):
    """Require macOS strict nested-resource signature verification for complete bundles."""
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)])


def signature_description(app):
    """Read signed identity/CDHash and the actual leaf certificate, independent of stage metadata."""
    result = subprocess.run(
        ["/usr/bin/codesign", "-d", "--verbose=4", str(app)],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode:
        raise ValueError("Unable to read code signature")
    fields = {}
    for line in result.stderr.splitlines():
        if line.startswith(("CDHash=", "TeamIdentifier=", "Signature=", "Authority=")):
            key, value = line.split("=", 1)
            fields.setdefault(key, []).append(value)
    if fields.get("Authority"):
        with tempfile.TemporaryDirectory(prefix="codex-side-cert-") as directory:
            prefix = Path(directory) / "certificate"
            run(["/usr/bin/codesign", "-d", "--extract-certificates=" + str(prefix), str(app)])
            certificate = Path(str(prefix) + "0").read_bytes()
            fields["CertificateSHA1"] = [hashlib.sha1(certificate).hexdigest().upper()]
    return fields


def source_fingerprint(source):
    """Bind a full staged bundle to its vendor source, including resources outside the ASAR.

    The vendor CodeDirectory hash seals the plist and complete resource manifest. Including
    it prevents a cache with an identical ASAR from replacing a differently packaged update.
    Older exact-build receipts lack this field and remain usable only in strict manual mode.
    """
    return {
        key: source.get(key)
        for key in ("version", "build", "asar_sha256", "cli_version", "source_signature")
    }


def inspect(app, allow_updated_version=False):
    """Classify bundles, optionally accepting updates whose target code and engine are unchanged.

    Strict mode keeps the original build/whole-archive pin. Compatibility mode still requires
    vendor signing, ASAR integrity, every exact target asset hash and the same engine version.
    A matched update is explicitly marked as awaiting desktop acceptance.
    """
    app = Path(app).expanduser().resolve()
    info = plist(app)
    result = {
        "app": str(app), "version": info.get("CFBundleShortVersionString"),
        "build": info.get("CFBundleVersion"), "profile": PROFILE["id"],
        "state": "unknown", "running": bool(running(app)),
        "desktop_acceptance": "pending",
        "updated_version": (
            info.get("CFBundleShortVersionString") != PROFILE["version"] or
            info.get("CFBundleVersion") != PROFILE["build"]
        ),
    }
    if info.get("CFBundleIdentifier") != PROFILE["bundle_id"]:
        result["reason"] = "Unexpected application bundle identifier"
        return result
    path = archive_path(app)
    _, _, raw = read_header(path)
    header_hash = sha256_bytes(raw)
    expected_header = info.get("ElectronAsarIntegrity", {}).get("Resources/app.asar", {}).get("hash")
    if header_hash != expected_header:
        result["reason"] = "ASAR header integrity mismatch"
        return result
    digest = sha256_file(path)
    result["asar_sha256"] = digest
    stamp = info.get(STAMP_KEY)
    original_hash = stamp.get("original_asar_sha256") if isinstance(stamp, dict) else digest
    result["original_asar_sha256"] = original_hash
    result["updated_version"] = (
        result["version"] != PROFILE["version"] or result["build"] != PROFILE["build"] or
        original_hash != PROFILE["asar_sha256"]
    )
    if result["updated_version"] and not allow_updated_version:
        result["reason"] = "Version/source changed; strict mode requires a dedicated adapter"
        return result
    # Verify signed code before invoking even the bundled CLI's read-only version command.
    verify_signature(app)
    signature = signature_description(app)
    if stamp is None:
        if signature.get("TeamIdentifier") != ["2DC432GLL2"]:
            result["reason"] = "Original vendor signing identity mismatch"
            return result
        result["source_signature"] = signature
        try:
            for name, expected in ASSETS.items():
                if sha256_bytes(read_file(path, "webview/assets/" + name)) != expected:
                    result["reason"] = "Unknown original asset: " + name
                    return result
            for name, expected in MAIN_ASSETS.items():
                if sha256_bytes(read_file(path, name)) != expected:
                    result["reason"] = "Unknown original main-process asset: " + name
                    return result
        except (KeyError, ValueError) as error:
            result["reason"] = "Patch target verification failed: " + str(error)
            return result
    elif not (
        isinstance(stamp, dict) and stamp.get("profile") == PROFILE["id"] and
        stamp.get("asar_sha256") == digest and isinstance(original_hash, str) and
        re.fullmatch(r"[a-f0-9]{64}", original_hash) is not None and
        (
            not result["updated_version"] or
            (
                stamp.get("source_version") == result["version"] and
                stamp.get("source_build") == result["build"] and
                isinstance(stamp.get("source_signature"), dict) and
                stamp["source_signature"].get("TeamIdentifier") == ["2DC432GLL2"]
            )
        )
    ):
        result["reason"] = "Unknown or modified archive; no writes are permitted"
        return result
    if stamp is not None:
        # Read the actual certificate, so a copied stamp cannot claim another signing identity.
        identity = stamp.get("signing_identity")
        if identity == "-":
            valid_identity = signature.get("Signature") == ["adhoc"] and not signature.get("Authority")
        else:
            valid_identity = (
                isinstance(identity, str) and re.fullmatch(r"[A-Fa-f0-9]{40}", identity) is not None and
                bool(signature.get("Authority")) and signature.get("CertificateSHA1") == [identity.upper()]
            )
        if not valid_identity:
            result["reason"] = "Patched bundle certificate does not match its signed manifest"
            return result
    # Legacy signed patches remain identifiable for receipt-bound rollback, even if unlaunchable.
    # Originals and this implementation must pass Electron's separate framework metadata seal.
    if stamp is None or stamp.get("implementation") == implementation_digest():
        try:
            result["framework_integrity"] = verify_framework(app, info.get("ElectronAsarIntegrity"))
        except (ValueError, OSError) as error:
            result["reason"] = str(error)
            return result
    cli = app / "Contents/Resources/codex-cli/bin/codex"
    result["cli_version"] = run([str(cli), "--version"]).strip()
    if result["cli_version"] != "codex-cli " + PROFILE["cli_version"]:
        result["reason"] = "Unrecognized bundled engine"
        return result
    if stamp is None:
        result["state"] = "original"
    else:
        result["state"] = (
            "patched" if stamp.get("implementation") == implementation_digest() else "older-patch"
        )
        result["signing_identity"] = stamp.get("signing_identity")
    result["compatibility"] = (
        "matched-update-not-desktop-validated" if result["updated_version"] else "pinned-build"
    )
    return result


def stage(app, output, identity="-", allow_updated_version=False, node="node"):
    """Build a complete signed copy from this source, with opt-in structural update checks.

    The selected Node executable can be absolute for GUI launchers with a minimal PATH.
    Source version, vendor signature and actual original hash travel in both stamp and receipt.
    """
    app = Path(app).expanduser().resolve()
    output = outside_repository(output)
    source = inspect(app, allow_updated_version=allow_updated_version)
    if source["state"] != "original":
        raise ValueError("stage requires a verified compatible original bundle: " + source.get("reason", ""))
    if identity != "-" and re.fullmatch(r"[A-Fa-f0-9]{40}", identity) is None:
        raise ValueError("Use a fixed certificate SHA-1, or '-' for isolated ad-hoc staging")
    if app == output or app in output.parents or output in app.parents:
        raise ValueError("Stage output and source bundle paths must not overlap")
    if output.exists():
        raise ValueError("Stage output already exists; choose a new directory")
    output.mkdir(parents=True, mode=0o700)
    clone = output / app.name
    run(["/usr/bin/ditto", str(app), str(clone)])
    replacements = build_replacements(archive_path(clone))
    # Node syntax checks write extracted code only into an external temporary directory.
    with tempfile.TemporaryDirectory(prefix="codex-side-js-") as check_directory:
        for name, data in replacements.items():
            target = Path(check_directory) / (Path(name).stem + ".mjs")
            target.write_bytes(data)
            run([str(node), "--check", str(target)])
    header_hash = rebuild(archive_path(clone), replacements)
    info = plist(clone)
    original_integrity = plist(app)["ElectronAsarIntegrity"]
    info["ElectronAsarIntegrity"]["Resources/app.asar"]["hash"] = header_hash
    synchronize_framework(clone, original_integrity, info["ElectronAsarIntegrity"])
    info[STAMP_KEY] = {
        "profile": PROFILE["id"], "implementation": implementation_digest(),
        "original_asar_sha256": source["asar_sha256"],
        "source_version": source["version"], "source_build": source["build"],
        "source_signature": source["source_signature"],
        "asar_sha256": sha256_file(archive_path(clone)), "signing_identity": identity,
    }
    (clone / "Contents/Info.plist").write_bytes(
        plistlib.dumps(info, fmt=plistlib.FMT_BINARY, sort_keys=False)
    )
    # Vendor identities and provisioned notification rights are unavailable to a local certificate.
    # Retaining APS/communication rights makes taskgated reject launch despite a valid code seal.
    entitlement_result = subprocess.run(
        ["/usr/bin/codesign", "-d", "--entitlements", ":-", str(app)],
        capture_output=True, timeout=30,
    )
    if entitlement_result.returncode:
        raise ValueError("Unable to read source entitlements")
    entitlements = plistlib.loads(entitlement_result.stdout)
    for key in (
        "com.apple.application-identifier", "application-identifier",
        "com.apple.developer.team-identifier", "keychain-access-groups",
        "com.apple.security.application-groups",
        "com.apple.developer.aps-environment",
        # Build 24141 adds Universal Links; its vendor provisioning profile cannot authorize
        # associated domains for our fixed local certificate, so taskgated rejects launch.
        "com.apple.developer.associated-domains",
        "com.apple.developer.usernotifications.communication",
    ):
        entitlements.pop(key, None)
    # A local certificate has no Apple Team ID; hardened runtime otherwise rejects Electron's dylib.
    entitlements["com.apple.security.cs.disable-library-validation"] = True
    entitlements_path = output / "signing-entitlements.plist"
    entitlements_path.write_bytes(plistlib.dumps(entitlements))
    run([
        "/usr/bin/codesign", "--force", "--deep", "--sign", identity,
        "--options", "runtime", "--entitlements", str(entitlements_path), str(clone),
    ])
    verify_signature(clone)
    receipt = {
        "version": 1, "profile": PROFILE["id"], "implementation": implementation_digest(),
        "bundle_name": app.name, "source": source,
        "patched_asar_sha256": info[STAMP_KEY]["asar_sha256"],
        "patched_assets": {name: sha256_bytes(data) for name, data in replacements.items()},
        "signature": signature_description(clone),
        "signing_identity": identity, "desktop_acceptance": "pending",
    }
    atomic_json(output / "receipt.json", receipt)
    verify_stage(output, allow_updated_version=allow_updated_version)
    # Detect an update racing the copy even when stage was allowed while the source was running.
    if source_fingerprint(inspect(app, allow_updated_version=allow_updated_version)) != source_fingerprint(source):
        raise ValueError("Source application changed during staging; discard this stage")
    return {"stage": str(output), "app": str(clone), "receipt": receipt}


def verify_stage(directory, allow_updated_version=False):
    """Verify receipt, source identity, assets and signed code before using any cached full bundle."""
    directory = outside_repository(directory)
    receipt = json.loads((directory / "receipt.json").read_text())
    if (
        receipt.get("profile") != PROFILE["id"] or
        receipt.get("implementation") != implementation_digest() or
        receipt.get("bundle_name") != Path(receipt["bundle_name"]).name
    ):
        raise ValueError("Stage receipt does not match this implementation")
    app = directory / receipt["bundle_name"]
    if inspect(app, allow_updated_version=allow_updated_version)["state"] != "patched":
        raise ValueError("Stage is not a verified current patch")
    info = plist(app)
    stamp = info.get(STAMP_KEY, {})
    source = receipt.get("source", {})
    if (
        stamp.get("original_asar_sha256") != source.get("asar_sha256") or
        (stamp.get("source_version") is not None and stamp["source_version"] != source.get("version")) or
        (stamp.get("source_build") is not None and stamp["source_build"] != source.get("build")) or
        (stamp.get("source_signature") is not None and stamp["source_signature"] != source.get("source_signature"))
    ):
        raise ValueError("Stage source receipt does not match its signed manifest")
    identity = receipt.get("signing_identity")
    if (
        not isinstance(identity, str) or
        (identity != "-" and re.fullmatch(r"[A-Fa-f0-9]{40}", identity) is None) or
        stamp.get("signing_identity") != identity
    ):
        raise ValueError("Stage signing identity does not match its signed manifest")
    if sha256_file(archive_path(app)) != receipt["patched_asar_sha256"]:
        raise ValueError("Staged archive changed")
    for name, digest in receipt["patched_assets"].items():
        if sha256_bytes(read_file(archive_path(app), name)) != digest:
            raise ValueError("Staged asset changed")
    signature = signature_description(app)
    if signature != receipt["signature"]:
        raise ValueError("Staged code signature changed")
    if identity == "-":
        if signature.get("Signature") != ["adhoc"] or signature.get("Authority"):
            raise ValueError("Ad-hoc stage has an unexpected certificate identity")
    elif (
        signature.get("Signature") == ["adhoc"] or not signature.get("Authority") or
        signature.get("CertificateSHA1") != [identity.upper()]
    ):
        raise ValueError("Stage is not signed by the selected fixed certificate")
    return app, receipt


@contextmanager
def state_lock(state, name="manager.lock"):
    """Serialize a named operation group; kernel locks release automatically after crashes.

    Launchers use a separate launch.lock over inspection, staging and opening. Individual
    exchanges retain manager.lock so manual commands cannot race a transaction.
    """
    state = outside_repository(state)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / name).open("a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield state


def atomic_swap(left, right):
    """Atomically exchange whole bundles with macOS RENAME_SWAP on the same filesystem."""
    left, right = Path(left), Path(right)
    if left.stat().st_dev != right.stat().st_dev:
        raise ValueError("Bundle exchange must be on one filesystem")
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    rename = libc.renamex_np
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(os.fsencode(left), os.fsencode(right), 2) != 0:
        raise OSError(ctypes.get_errno(), "Atomic bundle exchange failed")
    sync_directory(left.parent)
    sync_directory(right.parent)


def ensure_no_pending(state):
    """Reject a previous interrupted transaction until explicit recover has reconciled its hashes."""
    journal = state / "transaction.json"
    if journal.exists() and json.loads(journal.read_text()).get("status") == "prepared":
        raise ValueError("An interrupted transaction exists; run recover before any further writes")


def exchange(app, slot, state, operation, before_hash, after_hash):
    """Journal an atomic bundle swap and revert automatically if post-swap verification fails."""
    journal = {
        "version": 1, "status": "prepared", "operation": operation,
        "app": str(app), "slot": str(slot), "before": before_hash, "after": after_hash,
        "previous_installation": (
            json.loads((state / "installation.json").read_text())
            if (state / "installation.json").exists() else None
        ),
    }
    require_stopped(app)
    require_unchanged_shared_runtime(app, slot)
    if sha256_file(archive_path(app)) != before_hash:
        raise ValueError("Application changed before exchange")
    atomic_json(state / "transaction.json", journal)
    atomic_swap(app, slot)
    try:
        if sha256_file(archive_path(app)) != after_hash:
            raise ValueError("Exchanged bundle digest mismatch")
        verify_signature(app)
    except Exception:
        atomic_swap(app, slot)
        journal["status"] = "reverted"
        atomic_json(state / "transaction.json", journal)
        raise
    return journal


def commit_exchange(state, journal, installation):
    """Commit the install receipt before releasing the recovery journal after a verified swap."""
    atomic_json(state / "installation.json", installation)
    journal["status"] = "committed"
    atomic_json(state / "transaction.json", journal)


def apply(app, stage_directory, state=DEFAULT_STATE, allow_updated_version=False):
    """Install a selected stage only onto its own verified vendor source and retain the complete original."""
    app = Path(app).expanduser().resolve()
    staged, receipt = verify_stage(stage_directory, allow_updated_version=allow_updated_version)
    if receipt["signing_identity"] == "-":
        raise ValueError("Ad-hoc stages are for isolated validation; apply requires a fixed certificate")
    with state_lock(state) as state:
        ensure_no_pending(state)
        require_stopped(app)
        current = inspect(app, allow_updated_version=allow_updated_version)
        if current["state"] == "patched":
            return {"state": "already-patched", "app": str(app)}
        if current["state"] != "original":
            raise ValueError("Unknown/older application; refusing to overwrite")
        if current["asar_sha256"] != receipt["source"]["asar_sha256"]:
            raise ValueError("Stage was built from a different source")
        if (
            receipt["source"].get("source_signature") is not None and
            source_fingerprint(current) != source_fingerprint(receipt["source"])
        ):
            raise ValueError("Stage was built from a differently packaged vendor source")
        slot_parent = Path(tempfile.mkdtemp(prefix=".codex-side-patch-", dir=app.parent))
        slot = slot_parent / app.name
        run(["/usr/bin/ditto", str(staged), str(slot)])
        verify_signature(slot)
        # Recheck the whole vendor seal after copying: an updater may change non-ASAR resources.
        latest = inspect(app, allow_updated_version=allow_updated_version)
        if latest["state"] != "original" or source_fingerprint(latest) != source_fingerprint(current):
            raise ValueError("Application changed while preparing installation; no exchange was performed")
        journal = exchange(
            app, slot, state, "apply", current["asar_sha256"], receipt["patched_asar_sha256"],
        )
        installation = {
            "version": 1, "id": uuid.uuid4().hex, "app": str(app),
            "backup": str(slot), "receipt": receipt, "status": "applied",
        }
        commit_exchange(state, journal, installation)
        return {"state": "applied", "app": str(app), "backup": str(slot)}


def rollback(app, state=DEFAULT_STATE):
    """Restore the full saved vendor bundle, preserving all thread, layout and relation data."""
    app = Path(app).expanduser().resolve()
    with state_lock(state) as state:
        ensure_no_pending(state)
        require_stopped(app)
        installed = json.loads((state / "installation.json").read_text())
        if installed["app"] != str(app):
            raise ValueError("Backup belongs to another application path")
        current = inspect(app, allow_updated_version=True)
        source = installed["receipt"]["source"]
        if current["state"] == "original":
            if current.get("asar_sha256") == source["asar_sha256"]:
                return {"state": "already-original", "app": str(app)}
            raise ValueError("Application changed after installation; rollback refuses to overwrite it")
        if current.get("asar_sha256") != installed["receipt"]["patched_asar_sha256"]:
            raise ValueError("Application changed after installation; rollback refuses to overwrite it")
        backup = Path(installed["backup"])
        original = inspect(backup, allow_updated_version=True)
        if original["state"] != "original" or original.get("asar_sha256") != source["asar_sha256"]:
            raise ValueError("Original backup does not verify")
        if (
            source.get("source_signature") is not None and
            source_fingerprint(original) != source_fingerprint(source)
        ):
            raise ValueError("Original backup vendor fingerprint does not match the installation")
        journal = exchange(app, backup, state, "rollback", current["asar_sha256"], source["asar_sha256"])
        installed["status"] = "rolled-back"
        commit_exchange(state, journal, installed)
        return {"state": "rolled-back", "app": str(app), "retained_patch": str(backup)}


def recover(state=DEFAULT_STATE):
    """Revert a prepared swap after a crash, using both hashes and refusing unknown external changes."""
    with state_lock(state) as state:
        journal = json.loads((state / "transaction.json").read_text())
        if journal["status"] != "prepared":
            return {"state": "no-pending-transaction"}
        app, slot = Path(journal["app"]), Path(journal["slot"])
        require_stopped(app)
        pair = (sha256_file(archive_path(app)), sha256_file(archive_path(slot)))
        if pair == (journal["after"], journal["before"]):
            require_unchanged_shared_runtime(app, slot)
            atomic_swap(app, slot)
            verify_signature(app)
        elif pair != (journal["before"], journal["after"]):
            raise ValueError("Recovery found an external bundle change; no files were overwritten")
        previous = journal.get("previous_installation")
        if previous is None:
            (state / "installation.json").unlink(missing_ok=True)
        else:
            atomic_json(state / "installation.json", previous)
        journal["status"] = "recovered"
        atomic_json(state / "transaction.json", journal)
        return {"state": "recovered", "app": str(app)}


def watch(app, state, interval):
    """Monitor replacement/reinstallation by path and report status; never quit or silently patch apps."""
    previous = None
    while True:
        try:
            result = inspect(app)
        except (ValueError, OSError) as error:
            result = {"app": str(app), "state": "unavailable", "reason": str(error)}
        encoded = json.dumps(result, ensure_ascii=False, sort_keys=True)
        if encoded != previous:
            print(encoded, flush=True)
            previous = encoded
        time.sleep(interval)


def main(argv=None):
    """Expose explicit read-only/staging and installation commands with JSON results."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=DEFAULT_APP)
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE)
    commands = parser.add_subparsers(dest="command", required=True)
    status_parser = commands.add_parser("status")
    status_parser.add_argument("--try-updated-version", action="store_true")
    stage_parser = commands.add_parser("stage")
    stage_parser.add_argument("--output", type=Path, required=True)
    stage_parser.add_argument("--identity", default="-", help="Fixed signing certificate SHA-1")
    stage_parser.add_argument("--node", default="node", help="Node executable for syntax verification")
    stage_parser.add_argument("--try-updated-version", action="store_true")
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("stage", type=Path)
    verify_parser.add_argument("--try-updated-version", action="store_true")
    apply_parser = commands.add_parser("apply")
    apply_parser.add_argument("stage", type=Path)
    apply_parser.add_argument("--try-updated-version", action="store_true")
    commands.add_parser("rollback")
    commands.add_parser("recover")
    watch_parser = commands.add_parser("watch")
    watch_parser.add_argument("--interval", type=float, default=30)
    launch_parser = commands.add_parser("launch", help="Check/reapply if stopped, then open the existing app")
    launch_parser.add_argument("--identity", required=True, help="Fixed signing certificate SHA-1")
    launch_parser.add_argument("--node", default="node")
    launch_parser.add_argument("--no-notify", action="store_true", help="Suppress native notices")
    launcher_parser = commands.add_parser("create-launcher", help="Generate a standalone double-click launcher")
    launcher_parser.add_argument("--output", type=Path, required=True, help="New .app outside this repository")
    launcher_parser.add_argument("--identity", required=True)
    launcher_parser.add_argument("--node", default="node")
    args = parser.parse_args(argv)
    try:
        if args.command == "status":
            result = inspect(args.app, allow_updated_version=args.try_updated_version)
        elif args.command == "stage":
            result = stage(args.app, args.output, args.identity, args.try_updated_version, args.node)
        elif args.command == "verify":
            app, _ = verify_stage(args.stage, allow_updated_version=args.try_updated_version)
            result = {"state": "verified", "app": str(app), "desktop_acceptance": "pending"}
        elif args.command == "apply":
            result = apply(args.app, args.stage, args.state_dir, args.try_updated_version)
        elif args.command == "rollback":
            result = rollback(args.app, args.state_dir)
        elif args.command == "recover":
            result = recover(args.state_dir)
        elif args.command in ("launch", "create-launcher"):
            from .launcher import create_launcher, launch
            if args.command == "launch":
                result = launch(args.app, args.state_dir, args.identity, args.node, not args.no_notify)
            else:
                result = create_launcher(args.app, args.state_dir, args.output, args.identity, args.node)
        else:
            if not 1 <= args.interval <= 60:
                raise ValueError("Watch interval must be between 1 and 60 seconds")
            watch(args.app, args.state_dir, args.interval)
            return 0
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if result.get("state") == "blocked" else 0
    except (ValueError, OSError, KeyError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"state": "error", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

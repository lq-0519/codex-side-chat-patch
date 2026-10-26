"""Stage, verify and transactionally install a pinned patch outside the application."""

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
from .profile import PROFILE, ROOT, build_replacements, implementation_digest


# DEFAULT_APP is inspected by default; only explicit apply/rollback commands write to it.
DEFAULT_APP = Path("/Applications/ChatGPT.app")
# DEFAULT_STATE survives app replacement and stores receipts, locks and the transaction journal.
DEFAULT_STATE = Path.home() / "Library/Application Support/CodexSideChatPatch"
# STAMP_KEY identifies the patched plist; independent receipts also pin every changed asset.
STAMP_KEY = "CodexNativeSidePatch"


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
    """Detect the main executable and any helpers using this exact bundle path."""
    executable = Path(app).resolve() / "Contents/MacOS" / plist(app)["CFBundleExecutable"]
    processes = run(["/bin/ps", "-axo", "pid=,command="])
    bundle_prefix = str(Path(app).resolve()) + "/"
    return [
        line.strip() for line in processes.splitlines()
        if str(executable) in line or bundle_prefix in line.partition(" ")[2]
    ]


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


def inspect(app):
    """Classify original/current/older/unknown bundles using full archive and engine fingerprints."""
    app = Path(app).expanduser().resolve()
    info = plist(app)
    result = {
        "app": str(app), "version": info.get("CFBundleShortVersionString"),
        "build": info.get("CFBundleVersion"), "profile": PROFILE["id"],
        "state": "unknown", "running": bool(running(app)),
        "desktop_acceptance": "pending",
    }
    if (
        info.get("CFBundleIdentifier") != PROFILE["bundle_id"] or
        result["version"] != PROFILE["version"] or result["build"] != PROFILE["build"]
    ):
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
    cli = app / "Contents/Resources/codex-cli/bin/codex"
    result["cli_version"] = run([str(cli), "--version"]).strip()
    if result["cli_version"] != "codex-cli " + PROFILE["cli_version"]:
        result["reason"] = "Unrecognized bundled engine"
        return result
    stamp = info.get(STAMP_KEY)
    if digest == PROFILE["asar_sha256"] and stamp is None:
        verify_signature(app)
        if signature_description(app).get("TeamIdentifier") != ["2DC432GLL2"]:
            result["reason"] = "Original vendor signing identity mismatch"
            return result
        result["state"] = "original"
    elif (
        isinstance(stamp, dict) and stamp.get("profile") == PROFILE["id"] and
        stamp.get("asar_sha256") == digest and
        stamp.get("original_asar_sha256") == PROFILE["asar_sha256"]
    ):
        verify_signature(app)
        result["state"] = (
            "patched" if stamp.get("implementation") == implementation_digest() else "older-patch"
        )
        result["signing_identity"] = stamp.get("signing_identity")
    else:
        result["reason"] = "Unknown or modified archive; no writes are permitted"
    return result


def stage(app, output, identity="-"):
    """Build and sign an isolated full bundle, preserving the source and its vendor signature."""
    app = Path(app).expanduser().resolve()
    output = outside_repository(output)
    source = inspect(app)
    if source["state"] != "original":
        raise ValueError("stage requires an exact supported original bundle")
    if identity != "-" and re.fullmatch(r"[A-Fa-f0-9]{40}", identity) is None:
        raise ValueError("Use a fixed certificate SHA-1, or '-' for isolated ad-hoc staging")
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
            run(["node", "--check", str(target)])
    header_hash = rebuild(archive_path(clone), replacements)
    info = plist(clone)
    info["ElectronAsarIntegrity"]["Resources/app.asar"]["hash"] = header_hash
    info[STAMP_KEY] = {
        "profile": PROFILE["id"], "implementation": implementation_digest(),
        "original_asar_sha256": PROFILE["asar_sha256"],
        "asar_sha256": sha256_file(archive_path(clone)), "signing_identity": identity,
    }
    (clone / "Contents/Info.plist").write_bytes(
        plistlib.dumps(info, fmt=plistlib.FMT_BINARY, sort_keys=False)
    )
    # Keep non-team entitlements, but never claim OpenAI's keychain/app-group identity.
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
    ):
        entitlements.pop(key, None)
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
    verify_stage(output)
    # Detect an update racing the copy even when stage was allowed while the source was running.
    if sha256_file(archive_path(app)) != source["asar_sha256"]:
        raise ValueError("Source application changed during staging; discard this stage")
    return {"stage": str(output), "app": str(clone), "receipt": receipt}


def verify_stage(directory):
    """Verify independently stored asset, whole-archive and signed-code hashes before installation."""
    directory = outside_repository(directory)
    receipt = json.loads((directory / "receipt.json").read_text())
    if (
        receipt.get("profile") != PROFILE["id"] or
        receipt.get("implementation") != implementation_digest() or
        receipt.get("bundle_name") != Path(receipt["bundle_name"]).name
    ):
        raise ValueError("Stage receipt does not match this implementation")
    app = directory / receipt["bundle_name"]
    if inspect(app)["state"] != "patched":
        raise ValueError("Stage is not a verified current patch")
    identity = receipt.get("signing_identity")
    if (
        not isinstance(identity, str) or
        (identity != "-" and re.fullmatch(r"[A-Fa-f0-9]{40}", identity) is None) or
        plist(app).get(STAMP_KEY, {}).get("signing_identity") != identity
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
def state_lock(state):
    """Serialize install/rollback operations; a crashed process releases the kernel lock."""
    state = outside_repository(state)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / "manager.lock").open("a") as stream:
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


def apply(app, stage_directory, state=DEFAULT_STATE):
    """Install an explicitly selected stage with a stable certificate and retain the complete original."""
    app = Path(app).expanduser().resolve()
    staged, receipt = verify_stage(stage_directory)
    if receipt["signing_identity"] == "-":
        raise ValueError("Ad-hoc stages are for isolated validation; apply requires a fixed certificate")
    with state_lock(state) as state:
        ensure_no_pending(state)
        require_stopped(app)
        current = inspect(app)
        if current["state"] == "patched":
            return {"state": "already-patched", "app": str(app)}
        if current["state"] != "original":
            raise ValueError("Unknown/older application; refusing to overwrite")
        if current["asar_sha256"] != receipt["source"]["asar_sha256"]:
            raise ValueError("Stage was built from a different source")
        slot_parent = Path(tempfile.mkdtemp(prefix=".codex-side-patch-", dir=app.parent))
        slot = slot_parent / app.name
        run(["/usr/bin/ditto", str(staged), str(slot)])
        verify_signature(slot)
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
        current = inspect(app)
        if current["state"] == "original":
            return {"state": "already-original", "app": str(app)}
        if current.get("asar_sha256") != installed["receipt"]["patched_asar_sha256"]:
            raise ValueError("Application changed after installation; rollback refuses to overwrite it")
        backup = Path(installed["backup"])
        if inspect(backup)["state"] != "original":
            raise ValueError("Original backup does not verify")
        journal = exchange(app, backup, state, "rollback", current["asar_sha256"], PROFILE["asar_sha256"])
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
    commands.add_parser("status")
    stage_parser = commands.add_parser("stage")
    stage_parser.add_argument("--output", type=Path, required=True)
    stage_parser.add_argument("--identity", default="-", help="Fixed signing certificate SHA-1")
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("stage", type=Path)
    apply_parser = commands.add_parser("apply")
    apply_parser.add_argument("stage", type=Path)
    commands.add_parser("rollback")
    commands.add_parser("recover")
    watch_parser = commands.add_parser("watch")
    watch_parser.add_argument("--interval", type=float, default=30)
    args = parser.parse_args(argv)
    try:
        if args.command == "status":
            result = inspect(args.app)
        elif args.command == "stage":
            result = stage(args.app, args.output, args.identity)
        elif args.command == "verify":
            app, _ = verify_stage(args.stage)
            result = {"state": "verified", "app": str(app), "desktop_acceptance": "pending"}
        elif args.command == "apply":
            result = apply(args.app, args.stage, args.state_dir)
        elif args.command == "rollback":
            result = rollback(args.app, args.state_dir)
        elif args.command == "recover":
            result = recover(args.state_dir)
        else:
            if not 1 <= args.interval <= 60:
                raise ValueError("Watch interval must be between 1 and 60 seconds")
            watch(args.app, args.state_dir, args.interval)
            return 0
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"state": "error", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

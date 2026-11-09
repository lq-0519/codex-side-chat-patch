"""Synchronize the supported Electron ASAR metadata digest without disabling integrity checks."""

import hashlib
import mmap
from pathlib import Path
import re
import struct


# FRAMEWORK is the single thin ARM64 framework packaged by the supported desktop build.
FRAMEWORK = Path(
    "Contents/Frameworks/Codex Framework.framework/Versions/157.0.8103.39/Codex Framework"
)
# SENTINEL identifies Electron's reserved slot; used/version stay enabled at their original values.
SENTINEL = b"AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A"
# SLOT_SIZE includes the sentinel, two control bytes, and the 32-byte SHA256 metadata digest.
SLOT_SIZE = 66


def metadata_digest(integrity):
    """Hash sorted UTF-8 path/algorithm/hash strings exactly as Electron's macOS validator does.

    Reject unsupported algorithms and malformed descriptors before touching a binary. This is
    the digest of the plist's complete integrity dictionary, distinct from the ASAR header hash.
    """
    if (
        not isinstance(integrity, dict) or not integrity or
        any(not isinstance(path, str) or not path for path in integrity)
    ):
        raise ValueError("Missing Electron ASAR integrity dictionary")
    digest = hashlib.sha256()
    for path in sorted(integrity):
        entry = integrity[path]
        if (
            not isinstance(path, str) or not path or not isinstance(entry, dict) or
            entry.get("algorithm") != "SHA256" or not isinstance(entry.get("hash"), str) or
            re.fullmatch(r"[a-f0-9]{64}", entry["hash"]) is None
        ):
            raise ValueError("Unsupported Electron ASAR integrity descriptor")
        for value in (path, entry["algorithm"], entry["hash"]):
            digest.update(value.encode("utf-8"))
    return digest.digest()


def integrity_section(data):
    """Find one enabled version-1 slot in a bounded thin ARM64 Mach-O section.

    Require the sentinel to belong to __DATA_CONST,__asar_integrity, not an arbitrary matching
    string. Fat binaries, other CPUs, duplicate slots and unknown control-byte formats require
    a separate adapter. No integrity fuse or slot control byte is modified.
    """
    if len(data) < 32:
        raise ValueError("Truncated Electron framework")
    magic, cpu, subtype, kind, count, commands_size, _, _ = struct.unpack_from("<8I", data)
    if (magic, cpu, subtype, kind) != (0xFEEDFACF, 0x0100000C, 0, 6):
        raise ValueError("Unsupported Electron framework Mach-O format")
    end = 32 + commands_size
    if end > len(data) or count > commands_size // 8:
        raise ValueError("Invalid Electron framework load commands")
    offset, slots = 32, []
    for _ in range(count):
        if offset + 8 > end:
            raise ValueError("Truncated Electron framework load command")
        command, size = struct.unpack_from("<II", data, offset)
        if size < 8 or size % 8 or offset + size > end:
            raise ValueError("Invalid Electron framework load command length")
        if command == 0x19:
            if size < 72:
                raise ValueError("Truncated Electron framework segment")
            section_count = struct.unpack_from("<I", data, offset + 64)[0]
            if size != 72 + section_count * 80:
                raise ValueError("Invalid Electron framework section table")
            segment = data[offset + 8:offset + 24].rstrip(b"\0")
            for index in range(section_count):
                section = offset + 72 + index * 80
                name, owner, _, length, location = struct.unpack_from("<16s16sQQI", data, section)
                if name.rstrip(b"\0") == b"__asar_integrity":
                    if (
                        segment != b"__DATA_CONST" or owner.rstrip(b"\0") != segment or
                        length != SLOT_SIZE or location < end or location + length > len(data)
                    ):
                        raise ValueError("Unsupported Electron ASAR integrity section")
                    slots.append(location)
        offset += size
    if offset != end or len(slots) != 1:
        raise ValueError("Electron ASAR integrity section is missing or ambiguous")
    location = slots[0]
    if (
        data.find(SENTINEL) != location or data.find(SENTINEL, location + 1) != -1 or
        data[location:location + 34] != SENTINEL + b"\x01\x01"
    ):
        raise ValueError("Electron ASAR integrity slot is missing, ambiguous or unsupported")
    return location + 34


def verify_framework(app, integrity):
    """Require the framework's enabled metadata digest to match the entire current plist dictionary."""
    expected = metadata_digest(integrity)
    with (Path(app) / FRAMEWORK).open("rb") as stream:
        with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
            offset = integrity_section(data)
            if data[offset:offset + 32] != expected:
                raise ValueError("Electron framework ASAR metadata digest mismatch")
    return expected.hex()


def synchronize_framework(app, original, updated):
    """Change only the staged framework's digest after proving its original metadata is intact.

    The caller supplies the pre-edit and post-edit plist dictionaries and later re-signs the
    complete staged bundle. Readback verifies the updated digest. Unknown original bytes cause
    rejection before any write; the sentinel, enabled flag, version and surrounding bytes stay
    unchanged. This function must only be called on an independent staging copy.
    """
    before, after = metadata_digest(original), metadata_digest(updated)
    with (Path(app) / FRAMEWORK).open("r+b") as stream:
        with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_WRITE) as data:
            offset = integrity_section(data)
            if data[offset:offset + 32] != before:
                raise ValueError("Original Electron framework ASAR metadata digest mismatch")
            data[offset:offset + 32] = after
            data.flush()
    return verify_framework(app, updated)

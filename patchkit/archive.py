"""Read/rebuild Electron ASAR archives without changing original unpacked resources."""

import hashlib
import json
from pathlib import Path
import shutil
import struct


def sha256_bytes(data):
    """Return the lowercase digest used by ASAR SHA256 integrity descriptors."""
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    """Stream large application resources instead of reading the whole archive into RAM."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_header(path):
    """Validate Chromium pickle lengths and return the tree, payload offset, and raw JSON."""
    with Path(path).open("rb") as stream:
        prefix = stream.read(16)
        if len(prefix) != 16:
            raise ValueError("ASAR prefix is truncated")
        size, header_size, payload_size, json_size = struct.unpack("<4I", prefix)
        if size != 4 or header_size != payload_size + 4 or json_size > payload_size - 4:
            raise ValueError("Invalid ASAR pickle lengths")
        raw = stream.read(json_size)
        if len(raw) != json_size or 8 + header_size > Path(path).stat().st_size:
            raise ValueError("ASAR header is truncated")
    return json.loads(raw), 8 + header_size, raw


def resolve(tree, name):
    """Resolve an exact, traversal-free packaged file; links and unpacked files are rejected."""
    node = tree
    for part in name.split("/"):
        if not part or part in (".", ".."):
            raise ValueError("Invalid ASAR path")
        node = node["files"][part]
    if "offset" not in node or node.get("unpacked") or "link" in node:
        raise ValueError("Patch targets must be packed regular files")
    return node


def read_file(path, name):
    """Read a packed file and verify both whole-file and block digests before patching."""
    tree, start, _ = read_header(path)
    node = resolve(tree, name)
    offset, size = int(node["offset"]), node["size"]
    if offset < 0 or size < 0 or start + offset + size > Path(path).stat().st_size:
        raise ValueError("ASAR file range is invalid")
    with Path(path).open("rb") as stream:
        stream.seek(start + offset)
        data = stream.read(size)
    integrity = node.get("integrity")
    if integrity is None or integrity["algorithm"] != "SHA256":
        raise ValueError("ASAR file is missing SHA256 integrity")
    block_size = integrity["blockSize"]
    if block_size <= 0 or sha256_bytes(data) != integrity["hash"]:
        raise ValueError("ASAR file digest mismatch")
    blocks = [sha256_bytes(data[i:i + block_size]) for i in range(0, size, block_size)]
    if blocks != integrity["blocks"]:
        raise ValueError("ASAR block digest mismatch")
    return data


def serialize_header(tree):
    """Encode an aligned Chromium pickle, retaining JSON bytes for Electron's header hash."""
    raw = json.dumps(tree, ensure_ascii=False, separators=(",", ":")).encode()
    payload = struct.pack("<I", len(raw)) + raw
    payload += b"\0" * (-len(payload) % 4)
    header = struct.pack("<I", len(payload)) + payload
    return struct.pack("<II", 4, len(header)) + header, raw


def rebuild(path, replacements):
    """Append changed/new assets and atomically replace only the staged copy's archive.

    Original payload offsets and unpacked files are preserved. Every added file receives
    a whole-file digest plus 4 MiB block digests, and is read back after replacement.
    """
    path = Path(path)
    tree, start, _ = read_header(path)
    offset = path.stat().st_size - start
    for name, data in replacements.items():
        branch = tree
        parts = name.split("/")
        for part in parts[:-1]:
            if part in ("", ".", ".."):
                raise ValueError("Invalid ASAR addition")
            branch = branch["files"][part]
        if parts[-1] in ("", ".", ".."):
            raise ValueError("Invalid ASAR addition")
        old = branch["files"].get(parts[-1])
        block_size = old["integrity"]["blockSize"] if old else 4 * 1024 * 1024
        branch["files"][parts[-1]] = {
            "size": len(data), "offset": str(offset),
            "integrity": {
                "algorithm": "SHA256", "hash": sha256_bytes(data), "blockSize": block_size,
                "blocks": [
                    sha256_bytes(data[i:i + block_size]) for i in range(0, len(data), block_size)
                ],
            },
        }
        offset += len(data)
    prefix, raw = serialize_header(tree)
    temporary = path.with_name(path.name + ".patch-staged")
    try:
        with path.open("rb") as source, temporary.open("wb") as destination:
            destination.write(prefix)
            source.seek(start)
            shutil.copyfileobj(source, destination, 8 * 1024 * 1024)
            for data in replacements.values():
                destination.write(data)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    for name, data in replacements.items():
        if read_file(path, name) != data:
            raise ValueError("Rebuilt ASAR failed round-trip verification")
    return sha256_bytes(raw)

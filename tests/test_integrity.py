"""Use external miniature Mach-O fixtures to validate enabled Electron metadata seals."""

import hashlib
from pathlib import Path
import struct
import tempfile
import unittest

from patchkit import integrity


def framework_fixture(app, metadata):
    """Create a thin ARM64 dylib with one real section table and bytes surrounding the digest."""
    path = Path(app) / integrity.FRAMEWORK
    path.parent.mkdir(parents=True, exist_ok=True)
    header = struct.pack("<8I", 0xFEEDFACF, 0x0100000C, 0, 6, 1, 152, 0, 0)
    segment = struct.pack(
        "<II16s4Q4I", 0x19, 152, b"__DATA_CONST", 0, 1024, 0, 1024, 3, 3, 1, 0
    )
    section = struct.pack(
        "<16s16s2Q8I", b"__asar_integrity", b"__DATA_CONST", 256, 66, 256, 0, 0, 0, 0, 0, 0, 0
    )
    data = bytearray(header + segment + section)
    data.extend(b"N" * (256 - len(data)))
    data.extend(integrity.SENTINEL + b"\x01\x01" + integrity.metadata_digest(metadata))
    data.extend(b"surrounding-unmodified-bytes")
    path.write_bytes(data)
    return path


class FrameworkIntegrity(unittest.TestCase):
    """Reject unsupported binary layouts and stale metadata before writing a staged framework."""

    def setUp(self):
        """Allocate all binary analysis artifacts in a unique directory outside the repository."""
        self.temporary = tempfile.TemporaryDirectory(prefix="codex-framework-integrity-")
        self.app = Path(self.temporary.name)
        self.original = {"Resources/app.asar": {"algorithm": "SHA256", "hash": "a" * 64}}
        self.updated = {"Resources/app.asar": {"algorithm": "SHA256", "hash": "b" * 64}}
        self.path = framework_fixture(self.app, self.original)

    def tearDown(self):
        """Remove only this test's temporary fixture tree."""
        self.temporary.cleanup()

    def test_sync_changes_only_digest_and_tampering_is_rejected(self):
        """Keep enabled/version flags and neighboring bytes unchanged; enforce post-edit readback."""
        before = self.path.read_bytes()
        result = integrity.synchronize_framework(self.app, self.original, self.updated)
        after = self.path.read_bytes()
        self.assertEqual(result, integrity.metadata_digest(self.updated).hex())
        self.assertEqual(before[:290], after[:290])
        self.assertEqual(before[322:], after[322:])
        self.assertNotEqual(before[290:322], after[290:322])
        corrupted = bytearray(after)
        corrupted[300] ^= 1
        self.path.write_bytes(corrupted)
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            integrity.verify_framework(self.app, self.updated)

    def test_wrong_original_duplicate_disabled_and_unknown_layout_do_not_write(self):
        """Unknown metadata, control bytes, section ownership, CPU or duplicate slots never get patched."""
        valid = self.path.read_bytes()
        cases = [
            ("digest mismatch", lambda data: data.__setitem__(300, data[300] ^ 1)),
            ("ambiguous", lambda data: data.extend(integrity.SENTINEL)),
            ("unsupported", lambda data: data.__setitem__(288, 0)),
            ("unsupported", lambda data: data.__setitem__(289, 2)),
            ("Mach-O", lambda data: struct.pack_into("<I", data, 4, 0x01000007)),
            ("section", lambda data: data.__setitem__(120, ord("X"))),
            ("section", lambda data: struct.pack_into("<Q", data, 144, 65)),
            ("load command", lambda data: struct.pack_into("<I", data, 36, 4096)),
        ]
        for message, mutate in cases:
            with self.subTest(message=message):
                data = bytearray(valid)
                mutate(data)
                self.path.write_bytes(data)
                with self.assertRaisesRegex(ValueError, message):
                    integrity.synchronize_framework(self.app, self.original, self.updated)
                self.assertEqual(self.path.read_bytes(), data)

    def test_digest_uses_sorted_paths_and_exact_algorithm_strings(self):
        """Match Electron's concatenation order independent of dictionary insertion order."""
        metadata = {
            "Resources/z.asar": {"algorithm": "SHA256", "hash": "c" * 64},
            "Resources/a.asar": {"algorithm": "SHA256", "hash": "d" * 64},
        }
        expected = hashlib.sha256(
            ("Resources/a.asarSHA256" + "d" * 64 + "Resources/z.asarSHA256" + "c" * 64).encode()
        ).digest()
        self.assertEqual(integrity.metadata_digest(metadata), expected)
        self.assertEqual(integrity.metadata_digest(dict(reversed(list(metadata.items())))), expected)
        for invalid in ({}, {"Resources/a.asar": {"algorithm": "SHA512", "hash": "d" * 64}}):
            with self.assertRaises(ValueError):
                integrity.metadata_digest(invalid)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Entrypoint for the native Codex side-chat patch manager (Python 3.9+, macOS)."""

import sys

# Operational modules must not leave bytecode caches in the implementation repository.
sys.dont_write_bytecode = True

from patchkit.manager import main

if __name__ == "__main__":
    raise SystemExit(main())

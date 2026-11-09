"""Control next-launch native software updates without touching or restarting the application."""

import json
import os
from pathlib import Path
import tempfile


def read_policy(state):
    """Read the shared strict schema; absent, corrupt or unreadable settings fail closed."""
    path = Path(state) / "update-policy.json"
    error = None
    enabled = False
    try:
        value = json.loads(path.read_text())
        if (
            not isinstance(value, dict) or type(value.get("version")) is not int
            or value["version"] != 1 or type(value.get("enabled")) is not bool
        ):
            raise ValueError("Invalid update policy; expected version 1 and a boolean enabled")
        enabled = value["enabled"]
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as failure:
        error = str(failure)
    return {"enabled": enabled, "error": error, "path": str(path), "takes_effect": "next-launch"}


def set_policy(state, enabled):
    """Atomically persist the same private JSON used by the application menu; never launch CodeX."""
    if type(enabled) is not bool:
        raise ValueError("enabled must be a boolean")
    from .manager import outside_repository, sync_directory
    state = outside_repository(state)
    state.mkdir(parents=True, exist_ok=True)
    path = state / "update-policy.json"
    descriptor, temporary = tempfile.mkstemp(prefix="update-policy.", suffix=".temporary", dir=state)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump({"version": 1, "enabled": enabled}, stream)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(state)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return read_policy(state)

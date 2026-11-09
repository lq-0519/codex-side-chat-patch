#!/usr/bin/env python3
"""Manually verify the pinned engine with isolated storage and a local Responses fixture."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import threading
import time

# REPOSITORY is used only to import the profile and reject in-repository probe output.
REPOSITORY = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(REPOSITORY))
from patchkit.profile import PROFILE


class ProbeServer:
    """Own one isolated app-server process and complete JSON RPC logs for that process."""

    def __init__(self, codex, root, label):
        """Start stdio transport using an empty CODEX_HOME and workspace, without real API keys."""
        # Transport state keeps notification frames until the corresponding turn is awaited.
        self.next_id = 0
        self.buffer = b""
        self.notifications = []
        # Output streams belong exclusively to the caller-selected external fixture directory.
        self.log = (root / ("rpc-" + label + ".jsonl")).open("w")
        self.stderr = (root / ("server-" + label + ".stderr")).open("wb")
        environment = dict(os.environ)
        environment["CODEX_HOME"] = str(root / "home")
        for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"):
            environment.pop(key, None)
        self.process = subprocess.Popen(
            [str(codex), "app-server", "--listen", "stdio://"],
            cwd=root / "workspace", env=environment,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
        )
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)

    def record(self, direction, message):
        """Flush complete JSON input, output or request-completion records without field projection."""
        self.log.write(json.dumps({"direction": direction, "message": message}, ensure_ascii=False) + "\n")
        self.log.flush()

    def send(self, message):
        """Record the original JSON envelope before writing one UTF-8 stdio frame."""
        self.record("out", message)
        self.process.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode())
        self.process.stdin.flush()

    def receive(self, deadline):
        """Read one frame with a bounded deadline while retaining already-buffered frames."""
        while b"\n" not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not self.selector.select(remaining):
                raise TimeoutError("Waiting for the isolated app-server")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError("The isolated app-server exited")
            self.buffer += chunk
        line, self.buffer = self.buffer.split(b"\n", 1)
        message = json.loads(line)
        self.record("in", message)
        return message

    def request(self, method, params):
        """Register a finally logger before sending each request, including negative-control RPCs."""
        self.next_id += 1
        request = {"id": self.next_id, "method": method, "params": params}
        response = None
        error = None
        try:
            self.send(request)
            deadline = time.monotonic() + 25
            while True:
                message = self.receive(deadline)
                if message.get("id") == request["id"] and ("result" in message or "error" in message):
                    response = message
                    error = message.get("error")
                    return message
                self.notifications.append(message)
        except Exception as exception:
            error = {"type": type(exception).__name__, "message": str(exception)}
            raise
        finally:
            self.record("rpc-complete", {"request": request, "response": response, "error": error})

    def result(self, method, params):
        """Require success for a normal RPC while request() retains the exact success/error envelope."""
        response = self.request(method, params)
        if "error" in response:
            raise RuntimeError(json.dumps(response["error"], ensure_ascii=False))
        return response["result"]

    def __enter__(self):
        """Initialize the same experimental protocol exposed by the pinned application engine."""
        try:
            self.result("initialize", {
                "clientInfo": {"name": "codex_native_side_patch_probe", "version": "1.0.0"},
                "capabilities": {"experimentalApi": True},
            })
            self.send({"method": "initialized", "params": {}})
            return self
        except Exception:
            self.close()
            raise

    def __exit__(self, kind, value, traceback):
        """Stop this owned process even when an assertion fails; never touch the desktop process."""
        self.close()

    def close(self):
        """Allow queued persistence to flush, escalating only this owned probe process if needed."""
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.selector.close()
        self.stderr.close()
        self.log.close()

    def finish_turn(self, thread_id, text):
        """Await a real completed engine turn using only a deterministic local assistant response."""
        result = self.result("turn/start", {
            "threadId": thread_id, "input": [{"type": "text", "text": text}],
        })
        turn_id = result["turn"]["id"]
        deadline = time.monotonic() + 25
        while True:
            pending, self.notifications = self.notifications, []
            for message in pending:
                if message.get("method") == "turn/completed":
                    turn = message.get("params", {}).get("turn", {})
                    if turn.get("id") == turn_id:
                        if turn.get("status") != "completed":
                            raise RuntimeError("Fixture turn failed: " + json.dumps(turn))
                        return turn_id
            self.notifications.append(self.receive(deadline))

    def turns(self, thread_id, items_view):
        """Traverse native pages with a small limit to exercise exact cursor and boundary behavior."""
        cursor = None
        seen = set()
        turns = []
        while True:
            page = self.result("thread/turns/list", {
                "threadId": thread_id, "cursor": cursor, "limit": 1,
                "itemsView": items_view, "sortDirection": "asc",
            })
            turns.extend(page["data"])
            cursor = page.get("nextCursor")
            if cursor is None:
                return turns
            if cursor in seen:
                raise RuntimeError("Native pagination repeated a cursor")
            seen.add(cursor)


class FixtureEndpoint(BaseHTTPRequestHandler):
    """Serve fixed Responses SSE messages on loopback; never proxy to another provider."""

    def log_message(self, format, *args):
        """Suppress unstructured HTTP logs because complete payloads are separately recorded."""
        pass

    def do_POST(self):
        """Record the engine's full request context and return one controlled assistant message."""
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append(payload)
        number = len(self.server.requests)
        text = "LOCAL_ASSISTANT_TURN_" + str(number)
        message = {
            "id": "msg_fixture_" + str(number), "type": "message", "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": text, "annotations": []}],
        }
        response = {
            "id": "resp_fixture_" + str(number), "object": "response",
            "created_at": int(time.time()), "model": "persistence-probe",
            "status": "completed", "output": [message],
        }
        events = [
            {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
            {"type": "response.output_item.added", "output_index": 0,
             "item": {**message, "status": "in_progress", "content": []}},
            {"type": "response.content_part.added", "item_id": message["id"], "output_index": 0,
             "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}},
            {"type": "response.output_text.delta", "item_id": message["id"], "output_index": 0,
             "content_index": 0, "delta": text},
            {"type": "response.output_text.done", "item_id": message["id"], "output_index": 0,
             "content_index": 0, "text": text},
            {"type": "response.content_part.done", "item_id": message["id"], "output_index": 0,
             "content_index": 0, "part": message["content"][0]},
            {"type": "response.output_item.done", "output_index": 0, "item": message},
            {"type": "response.completed", "response": response},
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        for index, event in enumerate(events):
            event["sequence_number"] = index
            self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
        self.wfile.flush()


def require(condition, description):
    """Raise an explicit validation failure instead of depending on removable Python assert statements."""
    if not condition:
        raise RuntimeError(description)


def probe(codex, root, endpoint):
    """Verify persistent identity, display boundaries, context continuity and ephemeral controls."""
    parent_markers = ["PARENT_USER_TURN_1", "PARENT_USER_TURN_2"]
    side_markers = ["SIDE_USER_TURN_1", "SIDE_USER_TURN_2"]
    with ProbeServer(codex, root, "first") as server:
        parent = server.result("thread/start", {
            "cwd": str(root / "workspace"), "ephemeral": False, "historyMode": "paginated",
            "sandbox": "read-only", "approvalPolicy": "never",
        })["thread"]
        parent_ids = [server.finish_turn(parent["id"], marker) for marker in parent_markers]
        side = server.result("thread/fork", {
            "threadId": parent["id"], "ephemeral": False, "excludeTurns": True,
        })["thread"]
        require(side["id"] != parent["id"] and side["forkedFromId"] == parent["id"],
                "The persistent side thread did not retain its native parent relation")
        require(side.get("path") is not None and side.get("ephemeral") is False,
                "The persistent fork has no native rollout")
        boundary = server.turns(side["id"], "notLoaded")
        inherited_ids = [turn["id"] for turn in boundary]
        require(inherited_ids == parent_ids, "The inherited boundary does not match parent turn IDs")
        require(all(turn.get("items") == [] and turn.get("itemsView") == "notLoaded" for turn in boundary),
                "The boundary RPC loaded transcript bodies")
        for marker in side_markers:
            server.finish_turn(side["id"], marker)
        server.finish_turn(parent["id"], "LATER_PARENT_TURN_MUST_STAY_OUT")
        ephemeral = server.result("thread/fork", {
            "threadId": parent["id"], "ephemeral": True, "excludeTurns": True,
        })["thread"]
        require(ephemeral.get("path") is None, "The ephemeral negative control unexpectedly persisted")
        server.finish_turn(ephemeral["id"], "OLD_EPHEMERAL_SIDE_TURN")
        migration = server.request("thread/fork", {
            "threadId": ephemeral["id"], "ephemeral": False, "excludeTurns": True,
        })
        require("error" in migration, "The pinned engine's ephemeral migration behavior changed")
    expected_markers = parent_markers + side_markers + [
        "LOCAL_ASSISTANT_TURN_" + str(number) for number in range(1, 5)
    ]
    with ProbeServer(codex, root, "restarted") as server:
        resumed = server.result("thread/resume", {"threadId": side["id"], "excludeTurns": True})["thread"]
        require(resumed["id"] == side["id"], "Restart changed the original side thread ID")
        turns = server.turns(side["id"], "full")
        history = json.dumps(turns)
        require(all(marker in history for marker in expected_markers),
                "Restart lost parent or side text turns")
        require([turn["id"] for turn in turns if turn["id"] in inherited_ids] == inherited_ids,
                "Restart changed the inherited display boundary IDs")
        absent = {
            method: server.request(method, {"threadId": ephemeral["id"], **extra})
            for method, extra in (
                ("thread/read", {"includeTurns": False}),
                ("thread/resume", {"excludeTurns": True}),
            )
        }
        require(all("error" in response for response in absent.values()),
                "The ephemeral control unexpectedly survived engine restart")
        server.finish_turn(side["id"], "CONTINUE_SAME_SAVED_SIDE")
        continuation = json.dumps(endpoint.requests[-1])
        require(all(marker in continuation for marker in expected_markers),
                "Continued generation lost inherited or side context")
        require("LATER_PARENT_TURN_MUST_STAY_OUT" not in continuation and
                "OLD_EPHEMERAL_SIDE_TURN" not in continuation,
                "Continued generation imported another thread's later turns")
        # Exercise the same destructive native method used after a durable deletion claim.
        server.result("thread/delete", {"threadId": side["id"]})
        deleted = server.request("thread/read", {"threadId": side["id"], "includeTurns": False})
        require("error" in deleted, "Native deletion left a readable side rollout")
        parent_after_delete = server.result("thread/read", {
            "threadId": parent["id"], "includeTurns": False,
        })["thread"]
        require(parent_after_delete["id"] == parent["id"], "Side deletion affected the parent")
    with ProbeServer(codex, root, "deleted-restarted") as server:
        deleted = server.request("thread/resume", {"threadId": side["id"], "excludeTurns": True})
        require("error" in deleted, "A deleted side rollout survived engine restart")
    return {
        "state": "passed", "profile": PROFILE["id"], "parent_id": parent["id"],
        "side_id": side["id"], "inherited_turn_ids": inherited_ids,
        "checks": {
            "native_persistent_fork": True, "boundary_without_transcript_bodies": True,
            "original_identity_after_restart": True, "parent_and_side_turns_preserved": True,
            "continuation_context_preserved": True, "later_parent_turns_excluded": True,
            "ephemeral_missing_after_restart": True, "old_ephemeral_migration_rejected": True,
            "native_side_delete_preserves_parent": True, "deleted_side_missing_after_restart": True,
        },
        "desktop_acceptance": "pending",
    }


def main():
    """Require explicit external output and the pinned CLI; write reproducible fixture evidence."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", type=Path, required=True, help="Pinned app-bundled engine path")
    parser.add_argument("--output", type=Path, required=True, help="New directory outside the repository")
    args = parser.parse_args()
    root, codex = args.output.expanduser().resolve(), args.codex.expanduser().resolve()
    require(root != REPOSITORY and REPOSITORY not in root.parents, "Probe output must be outside Git")
    require(not root.exists(), "Probe output already exists; select a new directory")
    version = subprocess.run([str(codex), "--version"], check=True, capture_output=True, text=True).stdout.strip()
    require(version == "codex-cli " + PROFILE["cli_version"], "This probe requires the pinned engine version")
    root.mkdir(parents=True, mode=0o700)
    for name in ("home", "workspace"):
        (root / name).mkdir(mode=0o700)
    endpoint = ThreadingHTTPServer(("127.0.0.1", 0), FixtureEndpoint)
    # requests contains synthetic model contexts only, saved after every probe success or failure.
    endpoint.requests = []
    worker = threading.Thread(target=endpoint.serve_forever, daemon=True)
    worker.start()
    (root / "home/config.toml").write_text(
        'model = "persistence-probe"\nmodel_provider = "persistence_probe"\nweb_search = "disabled"\n'
        '[model_providers.persistence_probe]\nname = "Local fixture"\n'
        'base_url = "http://127.0.0.1:' + str(endpoint.server_port) + '/v1"\n'
        'wire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n'
    )
    try:
        results = probe(codex, root, endpoint)
        results["cli_version"] = version
    except Exception as error:
        results = {"state": "failed", "error": str(error), "cli_version": version}
        raise
    finally:
        endpoint.shutdown()
        endpoint.server_close()
        worker.join(timeout=5)
        (root / "local-responses-requests.json").write_text(json.dumps(endpoint.requests, ensure_ascii=False, indent=2) + "\n")
        (root / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

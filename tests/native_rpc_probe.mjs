/**
 * Exercise all pinned build 25894 RPC factories over isolated MessagePorts.
 * Read only packaged JavaScript, use synthetic conversation IDs, and never attach to the app.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { MessageChannel } from "node:worker_threads";
import * as persistence from "../runtime/persistence.mjs";

/** Pin each packaged RPC copy independently; aliases and export sets differ between copies. */
const chunks = {
  "398566.8e977c1734.js": "52dd500f32dde293eef5dd1812f0c39c8f7b9b1cbd9d11f5980c79d1dd060917",
  "885188.3857056929.js": "c890276c10ddc286a5e445ae49911464a5bbc4ce9a4d0ef10f6dccdf161a33e8",
  "932791.1dbd17ec78.js": "79dc1ba514caaea44afdf5703c60d0d92af5511e555c79844ff9d30089a8d401",
};
/** Locate the repository solely for the existing read-only ASAR decoder. */
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Permit either original or staged ASAR input without persisting extracted resources. */
const archive = process.argv[process.argv.indexOf("--asar") + 1];
assert.ok(process.argv.includes("--asar") && archive, "Pass --asar /path/to/Contents/Resources/app.asar");
/** Decode the three factories in memory; -B prevents Python caches inside the repository. */
const sources = JSON.parse(execFileSync("python3", ["-B", "-c", `
import base64, json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from patchkit.archive import read_file
archive = Path(sys.argv[2])
print(json.dumps({name: base64.b64encode(read_file(archive, "webview/assets/async/" + name)).decode()
                  for name in json.loads(sys.argv[3])}))
`, repository, archive, JSON.stringify(Object.keys(chunks))], { encoding: "utf8" }));
/** Load Node's bundled Acorn without adding npm dependencies or using a second JavaScript realm. */
const acorn = {};
vm.runInThisContext("(function(exports, require, module) {" +
  process.binding("natives")["internal/deps/acorn/acorn/dist/acorn"] + "\n})")(
  acorn, createRequire(import.meta.url), { exports: acorn });

/** Find one complete Rspack property, rather than matching text inside strings or another factory. */
function findFactory(node, matches = []) {
  if (node == null || typeof node !== "object") return matches;
  if (node.type === "Property" && node.key?.name === "Fkn8") matches.push(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => findFactory(child, matches));
    else if (value?.type) findFactory(value, matches);
  }
  return matches;
}

/** Evaluate an unchanged, hash-verified native factory with only Rspack's export helper. */
function loadNative(name) {
  const bytes = Buffer.from(sources[name], "base64");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), chunks[name]);
  const source = bytes.toString("utf8");
  const matches = findFactory(acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" }));
  assert.equal(matches.length, 1);
  const native = {};
  const require = () => { throw Error("Unexpected dependency in native RPC factory"); };
  require.d = (target, getters, values) => {
    for (const [key, getter] of Object.entries(getters)) {
      Object.defineProperty(target, key, { get: getter });
    }
    Object.assign(target, values);
  };
  const factory = matches[0];
  vm.runInThisContext("({" + source.slice(factory.start, factory.end) + "}).Fkn8",
    { filename: name })({}, native, require);
  return native;
}

for (const name of Object.keys(chunks)) {
  test(`${name}: guarded native main RPC, pipeline, subscription and deletion`, { timeout: 10000 }, async () => {
    const native = loadNative(name);
    const values = new Map();
    const storage = {
      readValue: key => values.get(key),
      writeValue: (key, value) => values.set(key, structuredClone(value)),
    };
    const calls = [];
    /** Return a native capability with cancellation and disposal, rather than a plain fake promise. */
    class Subscription extends native.TF {
      /** Verify that a returned capability remains callable without a wrapper promise. */
      cancel() { calls.push(["cancel"]); return { cancelled: true }; }
      /** Observe remote disposal on the owner, including asynchronous transport delivery. */
      [Symbol.dispose]() { calls.push(["subscription-dispose"]); }
    }
    /** Match the methods implicated in real logs while keeping every request and result synthetic. */
    class Service extends native.TF {
      /** Supply a synthetic main-thread result that also supports pre-resolution property access. */
      resumeConversation(input) {
        calls.push(["resumeConversation", input]);
        return { conversationId: input.conversationId, state: "ready" };
      }
      /** Return an empty native-shaped first page for the exact requested synthetic ID. */
      ensureConversationFirstPage(id) {
        calls.push(["ensureConversationFirstPage", id]); return { conversationId: id, data: [] };
      }
      /** Exercise the unguarded pinned-thread query that previously acquired a remote .bind path. */
      findPinnedThreadIds() { calls.push(["findPinnedThreadIds"]); return ["main-probe"]; }
      /** Exercise the unguarded MCP query implicated in the original renderer logs. */
      listMcpServers() { calls.push(["listMcpServers"]); return []; }
      /** Echo JSON requests so the guard's operation and thread arguments can be checked unchanged. */
      sendRequest(method, params) { calls.push(["sendRequest", method, params]); return { method, params }; }
      /** Record turn dispatch so deletion assertions can prove the worker was never reached. */
      startTurn(input) { calls.push(["startTurn", input]); return { started: true }; }
      /** Return a real native capability to validate cancellation and disposal across MessagePorts. */
      subscribe(input) { calls.push(["subscribe", input]); return new Subscription(); }
    }
    const { port1, port2 } = new MessageChannel();
    const server = native.ab(port1, new Service());
    const original = native.ab(port2, new native.TF());
    const rpc = persistence.guardedSideRpc(storage, "local", original);
    let duplicate, subscription;
    try {
      assert.deepEqual(await original.resumeConversation({ conversationId: "main-probe" }),
        { conversationId: "main-probe", state: "ready" }, "unmodified native control must work");
      assert.strictEqual(rpc.ensureConversationFirstPage, rpc.ensureConversationFirstPage);
      const resumed = rpc.resumeConversation({ conversationId: "main-probe" });
      assert.equal(await resumed.state, "ready", "the original RPC return supports pipelined access");
      assert.deepEqual(await resumed, { conversationId: "main-probe", state: "ready" });
      assert.deepEqual(await rpc.ensureConversationFirstPage("main-probe"),
        { conversationId: "main-probe", data: [] });
      assert.deepEqual(await rpc.findPinnedThreadIds(), ["main-probe"]);
      assert.deepEqual(await rpc.listMcpServers(), []);
      assert.deepEqual(await rpc.sendRequest("thread/resume", { threadId: "main-probe" }),
        { method: "thread/resume", params: { threadId: "main-probe" } });
      duplicate = rpc.dup();
      assert.equal(await duplicate.resumeConversation({ conversationId: "main-probe" }).state, "ready");
      subscription = await rpc.subscribe({ type: "conversation-event" });
      assert.deepEqual(await subscription.cancel(), { cancelled: true });
      storage.writeValue(persistence.DELETED_KEY, { "deleted-side": true });
      const before = calls.length;
      assert.throws(() => rpc.resumeConversation({ conversationId: "deleted-side" }), /deleted/);
      assert.throws(() => duplicate.startTurn({ threadId: "deleted-side" }), /deleted/);
      assert.throws(() => rpc.sendRequest("turn/start", { threadId: "deleted-side" }), /deleted/);
      assert.equal(calls.length, before, "blocked calls never cross the MessagePort");
      assert.deepEqual(await rpc.sendRequest("thread/delete", { threadId: "deleted-side" }),
        { method: "thread/delete", params: { threadId: "deleted-side" } });
      subscription[Symbol.dispose]();
      subscription = undefined;
      await rpc.listMcpServers();
      assert.ok(calls.some(call => call[0] === "subscription-dispose"),
        "disposing the returned native handle reaches its original owner");
    } finally {
      subscription?.[Symbol.dispose]();
      duplicate?.[Symbol.dispose]();
      rpc[Symbol.dispose]();
      server[Symbol.dispose]();
      port1.close();
      port2.close();
    }
  });
}

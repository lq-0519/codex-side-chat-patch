/**
 * Execute pinned build 25894 history construction, patched selectors and pagination-row rendering.
 * Synthetic snapshots reproduce the recording's gap/complete/gap transition without opening
 * the app or reading account data. Native UI output is inspected as JSX, not pixel geometry.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as persistence from "../runtime/persistence.mjs";

/** Pin the native timeline/history model and its actual loading-row renderer independently. */
const chunks = {
  "182735.7f13786b92.js": "119afcc814fe83e733d5b494d3201afe203c51b8d059998b2a8dbf3ed03ccd85",
  "992741.f8405d6468.js": "3eb169712943b4280ed06abda62405c2cee8cf4cc2d2cf060a87cce07508335a",
};
/** Reuse the repository's decoder and exact patch adapter without extracting files into Git. */
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Only the pinned original archive is accepted; staged resources are checked by stage verification. */
const archive = process.argv[process.argv.indexOf("--asar") + 1];
assert.ok(process.argv.includes("--asar") && archive, "Pass --asar <original>/Contents/Resources/app.asar");
/** Optionally reproduce the defect with the verified, previously installed runtime in memory. */
const previousArchive = process.argv.includes("--previous-asar")
  ? process.argv[process.argv.indexOf("--previous-asar") + 1] : "";
/** Keep decoded source in memory and prevent Python bytecode files in the repository. */
const sources = JSON.parse(execFileSync("python3", ["-B", "-c", `
import base64, json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from patchkit.archive import read_file
sources = {name: base64.b64encode(read_file(Path(sys.argv[2]),
           "webview/assets/async/" + name)).decode()
           for name in json.loads(sys.argv[3])}
if sys.argv[4]:
    sources["previousRuntime"] = base64.b64encode(read_file(Path(sys.argv[4]),
        "webview/assets/codex-native-side-patch-v1.mjs")).decode()
print(json.dumps(sources))
`, repository, archive, JSON.stringify(Object.keys(chunks)), previousArchive],
{ encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
/** Reject arbitrary prior code before executing the exact runtime implicated in the recording. */
let previousRuntime;
if (sources.previousRuntime) {
  const bytes = Buffer.from(sources.previousRuntime, "base64");
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "8dda5566c751a5063e92b80dab651b853101f987bb7c1b7fca041c0a9b86208a");
  previousRuntime = await import("data:text/javascript;base64," + sources.previousRuntime);
}
/** Use Node's bundled parser so the probe needs no installed packages or second object realm. */
const acorn = {};
vm.runInThisContext("(function(exports, require, module) {" +
  process.binding("natives")["internal/deps/acorn/acorn/dist/acorn"] + "\n})")(
  acorn, createRequire(import.meta.url), { exports: acorn });

/**
 * Extract only top-level Rspack factories from hash-verified original chunks.
 * AST offsets avoid matching module names in strings or nested application expressions.
 */
function factories(name) {
  const bytes = Buffer.from(sources[name], "base64");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), chunks[name]);
  const source = bytes.toString("utf8");
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const declaration = ast.body.find(node => node.type === "ExportNamedDeclaration" &&
    node.declaration?.declarations?.some(item => item.id.name === "__webpack_modules__"));
  const table = declaration.declaration.declarations.find(item => item.id.name === "__webpack_modules__");
  return Object.fromEntries(table.init.properties.map(node =>
    [node.key.name ?? node.key.value, source.slice(node.start, node.end)]));
}
/** These sources also supply the native BiLL gap model used by the selector's history input. */
const timelineFactories = factories("182735.7f13786b92.js");
/** Apply the same reviewed adapter used by full-app staging, not a copied test-only patch. */
const patchedTimeline = execFileSync("python3", ["-B", "-c", `
import sys
sys.path.insert(0, sys.argv[1])
from patchkit.profile import patch_module
print(patch_module("t3Ye", sys.stdin.read()), end="")
`, repository], { input: timelineFactories.t3Ye, encoding: "utf8" });

/** Execute a native factory with isolated dependency adapters and the real patch runtime. */
function loadFactory(source, name, dependencies, runtime = persistence) {
  const exports = {};
  const require = id => {
    assert.ok(id in dependencies, `Unexpected ${name} dependency: ${id}`);
    return dependencies[id];
  };
  require.n = value => () => value;
  require.d = (target, getters, values = {}) => {
    for (const [key, getter] of Object.entries(getters)) Object.defineProperty(target, key, { get: getter });
    Object.assign(target, values);
  };
  vm.runInThisContext("(function(__scp){return ({" + source + "})." + name + ";})")(runtime)(
    {}, exports, require);
  return exports;
}

/** Stable signal tokens let the native selector execute against synthetic entity snapshots. */
function tokens(module) {
  return new Proxy({}, { get: (_, key) => `${module}.${String(key)}` });
}
/** Capture the exact selector callbacks while leaving turn projection/renderEntries native. */
const signals = { i1: (_, read) => ({ read }) };
/** Native merge is required only for duplicate entities; these snapshots contain unique keys. */
const history = loadFactory(timelineFactories.BiLL, "BiLL", {
  wnzA: { H: () => { throw Error("Unexpected duplicate synthetic turn"); } },
});

/** Supply complete synthetic turns including the fields read by the native projection. */
function turn(id, status = "completed") {
  return {
    turnId: id, status, params: { input: [{ type: "text", text: `message:${id}` }],
      clientUserMessageId: `client:${id}` },
    items: [{ id: `item:${id}`, type: "userMessage", content: [{ type: "text", text: `message:${id}` }] }],
  };
}

/**
 * Wire native store signals and turn lookup to one immutable-by-contract snapshot.
 * Application transport and unrelated UI predicates are stubbed; native timeline construction,
 * admission checks, inherited filtering, render-entry conversion and gap renderer execute.
 */
function select(source, snapshot, hostId = "local", managed = true, runtime = persistence) {
  const storage = {
    readValue: key => key === persistence.REGISTRY_KEY && managed ? {
      version: 1, records: { "side-probe": {
        durable: { conversationId: "side-probe", sourceConversationId: "parent-probe",
          hostId: "local", accountId: "account-probe", userId: "user-probe" },
        inheritedTurnIds: ["parent-first", "parent-last"], hidden: false,
      } },
    } : undefined,
  };
  const dependencies = Object.fromEntries([
    "wviT", "DBCl", "KCMt", "eJd0", "tl5a", "vdpW", "qMca", "AMnk", "H7j2",
    "g8rQ", "OWtl", "UxLy", "HMTR", "AqC0", "Xxxx",
  ].map(id => [id, tokens(id)]));
  Object.assign(dependencies, {
    zTeN: signals, xCr9: (items, predicate) => items.findLast(predicate),
    SZCv: (left, right) => left === right,
    V7mA: {
      codexSidePatchStorage: () => storage, codexSidePatchRegistryAtom: () => "registry",
      rl: ({ turns }) => turns.findLast(item => item.status === "inProgress"),
      hd: () => false, Gq: (item, id) => item.clientId === id,
    },
    g8rQ: { s: () => false }, eJd0: { r0: () => false },
    AqC0: { EA: value => value.params.input.length > 0 || value.items.length > 0 },
    Xxxx: { o: (id, index) => id ?? `pending:${index}` },
    vdpW: { ...Object.fromEntries(["_t", "M", "Ko", "hm", "mz"].map(key => [key, `vdpW.${key}`])),
      od: (_, key) => snapshot.entitiesByKey[key.entityKey] },
  });
  const native = loadFactory(source, "t3Ye", dependencies, runtime);
  const get = (signal, key) => {
    if (signal?.read) return signal.read(key, { get, scope: {} });
    switch (signal) {
      case "tl5a.Af": return true;
      case "tl5a.dA": return [];
      case "tl5a.qX": return hostId;
      case "tl5a.pp": return snapshot.isComplete;
      case "qMca.LG": return "codex";
      case "vdpW._t": return key == null ? null : history.AM(snapshot);
      case "vdpW.M": return key == null ? null : Object.keys(snapshot.entitiesByKey).map(entityKey =>
        ({ hostId, threadId: "side-probe", entityKey }));
      case "vdpW.Ko": return snapshot.entitiesByKey[key.entityKey];
      case "vdpW.hm": return [];
      default: return undefined;
    }
  };
  return get(native.kb, { conversationId: "side-probe", isBackgroundSubagentsEnabled: false });
}

/** The actual native loading component emits the status element and its layout padding. */
const jsx = (type, props) => ({ type, props });
const spinner = loadFactory(factories("992741.f8405d6468.js").yLzP, "yLzP", {
  ABep: { jsx, jsxs: jsx }, QosV: { c: size => Array(size).fill(Symbol.for("react.memo_cache_sentinel")) },
  oyxz: { A: "formatted-message" }, ygO2: { $: "retry-button" }, RNul: { y: "spinner" },
});

test("actual native gap/complete/gap snapshots reproduce the loader and keep first side content stable after patch", () => {
  const turns = [turn("parent-first"), turn("parent-last"), turn("side-first", "inProgress")];
  const snapshots = [
    history.Kg(turns, { cursor: "older-parent", oldestLoadedTurnId: "parent-first" }, 1),
    history.Sf(turns, 2),
    history.Kg(turns, { cursor: "older-parent", oldestLoadedTurnId: "parent-first" }, 3),
  ];
  const before = structuredClone(snapshots);
  const control = snapshots.map(snapshot => select(timelineFactories.t3Ye, snapshot));
  assert.deepEqual(control.map(view => view.renderEntries.filter(entry => entry.type === "gap").length),
    [1, 0, 1], "unmodified native render input inserts/removes the loader seen in the recording");
  const nativeRow = spinner.N({});
  assert.equal(nativeRow.type, "div");
  assert.equal(nativeRow.props.className, "flex justify-center py-4");
  assert.equal(nativeRow.props.children.props.role, "status");
  if (previousRuntime) {
    const previous = snapshots.map(snapshot => select(patchedTimeline, snapshot, "local", true, previousRuntime));
    assert.deepEqual(previous.map(view => view.renderEntries.filter(entry => entry.type === "gap").length),
      [1, 0, 1], "the actually installed old runtime retains the inherited loading row");
    assert.ok(previous.every(view =>
      view.visibleTurnEntries.length === 1 && view.visibleTurnEntries[0].turnId === "side-first"));
  }
  const patched = snapshots.map(snapshot => select(patchedTimeline, snapshot));
  for (const view of patched) {
    assert.deepEqual(view.renderEntries.map(entry => entry.turnId), ["side-first"]);
    assert.strictEqual(view.renderEntries[0].turn, turns[2]);
  }
  assert.deepEqual(snapshots, before, "native context, generation, islands and page handles are untouched");
});

test("native first-turn admission stays visible through pending, admitted and streaming snapshots", () => {
  const pending = turn(null, "inProgress");
  pending.pendingUserMessageAdmission = true;
  const active = turn("side-first", "inProgress");
  active.params = pending.params;
  active.items[0].clientId = pending.params.clientUserMessageId;
  for (const own of [[pending], [pending, active], [active]]) {
    const snapshot = history.Kg([turn("parent-last"), ...own],
      { cursor: "older-parent", oldestLoadedTurnId: "parent-last" }, 1);
    const view = select(patchedTimeline, snapshot);
    assert.equal(view.renderEntries.length, 1);
    assert.strictEqual(view.renderEntries[0].turn, own.at(-1));
    assert.equal(view.hasRenderableTurns, true);
  }
});

test("native older side pages and unknown boundaries retain their loading rows and handles", () => {
  for (const handle of [
    { cursor: "older-side", oldestLoadedTurnId: "side-old" },
    { cursor: "unknown-page" },
  ]) {
    const oldest = turn("side-old");
    oldest.itemsPagination = { hasLoadedOldest: false, olderCursor: "partial-side-items" };
    const snapshot = history.Kg([oldest, turn("side-new")], handle, 4);
    const before = structuredClone(snapshot);
    const view = select(patchedTimeline, snapshot);
    assert.equal(view.renderEntries[0].type, "gap");
    assert.strictEqual(view.renderEntries[1].turn.itemsPagination, oldest.itemsPagination);
    assert.deepEqual(snapshot, before);
  }
  const snapshot = history.Kg([turn("parent-last"), turn("side-first")],
    { cursor: "older-parent", oldestLoadedTurnId: "parent-last" }, 5);
  for (const [host, managed] of [["remote", true], ["local", false]]) {
    assert.deepEqual(select(patchedTimeline, snapshot, host, managed),
      select(timelineFactories.t3Ye, snapshot, host, managed));
  }
});

test("inherited cursor anchors work without content while interior own and trailing gaps remain", () => {
  const own = turn("side-first");
  const snapshot = history.Kg([own],
    { cursor: "inherited-page", oldestLoadedTurnId: "parent-last" }, 6);
  assert.deepEqual(select(patchedTimeline, snapshot).renderEntries.map(entry => entry.turnId), ["side-first"]);
  const secondIsland = history.Sf([turn("side-new")], 7).islands[0];
  const interior = history.Kg([turn("parent-last"), own],
    { cursor: "older-parent", oldestLoadedTurnId: "parent-last" }, 6);
  interior.islands[0].newerBoundary = history.Px("own-newer",
    { cursor: "missing-side", oldestLoadedTurnId: "side-first" });
  interior.islands.push(secondIsland);
  Object.assign(interior.entitiesByKey, history.Sf([turn("side-new")], 7).entitiesByKey);
  secondIsland.newerBoundary = history.Px("trailing-newer",
    { cursor: "newer-side", oldestLoadedTurnId: "side-new" });
  const view = select(patchedTimeline, interior);
  assert.deepEqual(view.renderEntries.map(entry => entry.type ?? entry.turnId),
    ["side-first", "gap", "side-new", "gap"]);
});

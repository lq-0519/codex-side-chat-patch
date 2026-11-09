/**
 * Exercise unchanged build 25894 updater code with synthetic native bindings.
 * No Electron process, real network, download, install or application restart is used.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/** Pin the real native gate and update manager instead of testing a reimplementation. */
const pins = {
  ".vite/build/early-bootstrap.js": "5fb7f97bb289c4672d3d9e0cbb5e3352ecafa9c9224de20825b2a9f9770fa8ec",
  ".vite/build/early-bootstrap-339-cb7e73ca5a71df7c.js": "2dd5cefc9452ffdce9b41e7e8463204b444202d7821b049b71dd6f3ac22783de",
};
/** Decode source in memory only, with Python bytecode disabled. */
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archive = process.argv[process.argv.indexOf("--asar") + 1];
assert.ok(process.argv.includes("--asar") && archive, "Pass --asar for the pinned original application");
const sources = JSON.parse(execFileSync("python3", ["-B", "-c", `
import base64, json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from patchkit.archive import read_file
print(json.dumps({name: base64.b64encode(read_file(Path(sys.argv[2]), name)).decode()
                  for name in json.loads(sys.argv[3])}))
`, repository, archive, JSON.stringify(Object.keys(pins))], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
/** Use Node's bundled parser and the same JavaScript realm as the original native class. */
const acorn = {};
vm.runInThisContext("(function(exports, require, module) {" +
  process.binding("natives")["internal/deps/acorn/acorn/dist/acorn"] + "\n})")(
  acorn, createRequire(import.meta.url), { exports: acorn });

/** Find one complete AST node while rejecting ambiguous module or class matches. */
function extract(name, predicate) {
  const bytes = Buffer.from(sources[name], "base64");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pins[name]);
  const source = bytes.toString("utf8");
  const matches = [];
  function visit(node) {
    if (node == null || typeof node !== "object") return;
    if (predicate(node)) matches.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value?.type) visit(value);
    }
  }
  visit(acorn.parse(source, { ecmaVersion: "latest" }));
  assert.equal(matches.length, 1);
  return source.slice(matches[0].start, matches[0].end);
}

/** Resolve the unchanged native build-flavor gate with synthetic metadata and logger exports. */
function nativeGate() {
  const source = extract(Object.keys(pins)[0], node => node.type === "Property" && node.key?.value === 84261);
  const exported = {};
  const require = id => {
    if (id === 59596) return { x1: { Dev: "dev", Nightly: "nightly", InternalAlpha: "internal-alpha", PublicBeta: "public-beta", Prod: "prod" } };
    if (id === 74487) return { vB: () => () => ({}) };
    if (id === 8892) return { C: () => null };
    throw Error("Unexpected native gate dependency: " + id);
  };
  require.d = (target, getters, values) => {
    for (const [key, getter] of Object.entries(getters)) Object.defineProperty(target, key, { get: getter });
    Object.assign(target, values);
  };
  vm.runInThisContext("({" + source + "})[84261]")({}, exported, require);
  return exported.x;
}

/** Inject only external dependencies; every updater method and branch retains original code. */
function updaterFixture(enabled) {
  const source = extract(Object.keys(pins)[1], node => node.type === "ClassDeclaration" &&
    node.body.body.some(method => method.key?.name === "initializeMacSparkle"));
  const calls = [];
  const timers = [];
  const sink = {};
  const addon = new Proxy({}, {
    get(_, name) {
      return (...args) => {
        calls.push([name, ...args]);
        if (name.startsWith("set") && name.endsWith("Sink")) sink[name] = args[0];
        if (name === "checkForUpdateInformation") sink.setUpdateCheckResultSink({ status: "no-update" });
      };
    },
  });
  const timer = (callback, delay) => {
    const value = { callback, delay, unref() {} };
    timers.push(value);
    return value;
  };
  const deps = {
    a: {
      ipcMain: { handle: (...args) => calls.push(["ipc", ...args]) },
      app: { getVersion: () => "26.1103.60933", quit() { throw Error("Unexpected quit"); }, relaunch() { throw Error("Unexpected relaunch"); } },
    },
    r: path, o: { $Cz: () => new Proxy({}, { get: () => () => {} }) },
    m: { x: { Prod: "prod", isInternal: () => false } },
    b: { C: key => key === "codexSparkleFeedUrl" ? "https://example.invalid/synthetic-appcast" : null },
    $: name => { calls.push(["load", name]); return addon; },
    V: () => 1000,
    p: () => (a, b) => JSON.stringify(a) === JSON.stringify(b),
    process: { platform: "darwin", execPath: "/synthetic/Codex", resourcesPath: "/synthetic/resources" },
    setTimeout: timer, clearTimeout: () => {}, setInterval: timer,
  };
  const Constructor = vm.runInThisContext("(function({" + Object.keys(deps).join(",") + "}){return " + source + ";})")(deps);
  const updater = new Constructor({
    enableUpdater: enabled, buildFlavor: "prod", isPackaged: true, isTrustedIpcEvent: () => true,
    getMacExecutableIdentity: () => ({ dev: 1, ino: 1 }),
  });
  return { updater, calls, timers };
}

test("native build gate rejects all update platforms and flavors when disabled", () => {
  const gate = nativeGate();
  for (const flavor of ["dev", "nightly", "internal-alpha", "public-beta", "prod"]) {
    for (const platform of ["darwin", "win32", "linux"]) {
      assert.equal(gate.shouldIncludeUpdater(flavor, platform, { CODEX_SPARKLE_ENABLED: "false" }), false);
    }
  }
  assert.equal(gate.shouldIncludeSparkle("prod", "darwin", { CODEX_SPARKLE_ENABLED: "true" }), true);
});

test("disabled native updater has no IPC, timers, binding loads or download/install recovery", { timeout: 5000 }, async () => {
  const { updater, calls, timers } = updaterFixture(false);
  await updater.initialize();
  await updater.checkForUpdates();
  assert.equal(await updater.installUpdatesIfAvailable(), false);
  assert.equal((await updater.checkForUpdateInformation()).status, "unavailable");
  await updater.latchInAppUpdatesEnabledForLaunch(true);
  await updater.startUpdaterAfterStartupFailure();
  await updater.initializeUpdater();
  updater.setAutomaticBackgroundDownloadsEnabled(true);
  updater.setSparkleQueryParams({ beta: true, planType: "synthetic" });
  updater.isUpdateReady = true;
  await updater.installForcedUpdate();
  assert.equal(updater.hasUpdater(), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(timers, []);
});

test("enabled native updater retains automatic, manual and installation behavior", { timeout: 5000 }, async () => {
  const { updater, calls, timers } = updaterFixture(true);
  await updater.initialize();
  assert.equal(calls[0][0], "ipc");
  assert.equal(timers[0].delay, 300000);
  timers[0].callback();
  await updater.initializeUpdater();
  assert.equal(updater.hasUpdater(), true);
  await updater.checkForUpdates();
  assert.equal((await updater.checkForUpdateInformation()).status, "no-update");
  assert.equal(await updater.installUpdatesIfAvailable(), true);
  for (const name of ["load", "init", "checkForUpdatesInBackground", "checkForUpdates", "installLatestUpdate"]) {
    assert.ok(calls.some(call => call[0] === name), name);
  }
  assert.equal(calls.filter(call => call[0] === "load").length, 1);
});

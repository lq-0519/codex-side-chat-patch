/** Behavioral checks use synthetic identities/turns only and never read real conversation data. */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as persistence from "../runtime/persistence.mjs";

/** Create a native-KV-shaped fixture whose values survive a simulated renderer restart. */
function storageFixture() {
  const values = new Map();
  return {
    readValue: (key) => values.get(key),
    writeValue: (key, value) => values.set(key, structuredClone(value)),
  };
}

/** Produce valid native descriptors for independent parent/account isolation cases. */
function durable(id = "side-one", parent = "parent-one", account = "account-one") {
  return {
    conversationId: id, sourceConversationId: parent, hostId: "local",
    parentNavigationPath: `/thread/${parent}`, accountId: account, userId: "user-one",
    collaborationMode: null, contextInjected: true, presentation: "side-chat", title: id,
  };
}

test("foreground right side chats clear both native full-view sources and preserve later user actions", () => {
  const signals = { hy: "layout", em: "panelFull", A6: "workspaceFull" };
  const values = new Map();
  const calls = [];
  const reads = [];
  const modules = {
    QcW8: signals,
    ZU27: {
      zs: (scope, full, options) => {
        calls.push(["panel", full, options.notifyTab]);
        scope.set(signals.hy, full ? "full" : "split");
        scope.set(signals.em, full);
      },
      X8: (scope, full, options) => {
        calls.push(["workspace", full, options.notifyTab]);
        scope.set(signals.A6, full);
      },
    },
  };
  const context = { n: id => { reads.push(id); return modules[id]; } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL("../hooks/panel-open.js", import.meta.url), "utf8"), context);
  const scope = {
    get: key => values.get(key),
    set: (key, value) => values.set(key, value),
  };
  for (const layout of ["full", "split"]) {
    for (const panelFull of [false, true]) {
      for (const workspaceFull of [false, true]) {
        values.set(signals.hy, layout);
        values.set(signals.em, panelFull);
        values.set(signals.A6, workspaceFull);
        calls.length = 0;
        context.codexSidePatchRevealSplit(scope, { panelId: "right" }, "local", true);
        assert.deepEqual([...values.values()], ["split", false, false]);
        assert.equal(calls.length, Number(layout !== "split" || panelFull) + Number(workspaceFull));
        assert.ok(calls.every(call => call[1] === false && call[2] === false));
      }
    }
  }
  calls.length = 0;
  context.codexSidePatchRevealSplit(scope, { panelId: "right" }, "local", true);
  assert.equal(calls.length, 0, "opening another tab in a split panel needs no layout writes");
  modules.ZU27.zs(scope, true, { notifyTab: true });
  modules.ZU27.X8(scope, true, { notifyTab: true });
  assert.deepEqual([...values.values()], ["full", true, true],
    "the open hook does not hold or subscribe to layout after the reveal");
  for (const [hostId, panelId, foreground] of [
    ["local", "right", false], ["remote", "right", true], ["local", "bottom", true],
  ]) {
    reads.length = 0;
    calls.length = 0;
    context.codexSidePatchRevealSplit(scope, { panelId }, hostId, foreground);
    assert.equal(reads.length, 0);
    assert.equal(calls.length, 0);
    assert.deepEqual([...values.values()], ["full", true, true]);
  }
});

test("sidebar catalog titles match each side tab across legacy, closed and new registry snapshots", () => {
  const storage = storageFixture();
  const identity = { accountId: "account-one", userId: "user-one" };
  const own = { ...durable(), title: "侧边自己的名字".repeat(10) };
  persistence.remember(storage, own, []);
  persistence.remember(storage, { ...durable("second"), title: "Side chat 2" }, []);
  persistence.hide(storage, "second");
  persistence.remember(storage, durable("foreign", "parent-one", "other-account"), []);
  persistence.remember(storage, { ...durable("other-user"), userId: "other-user" }, []);
  /** Native fields must retain identity and value while a display title is projected. */
  const task = (id) => Object.freeze({
    kind: "local", summary: Object.freeze({
      hostId: "local", conversationId: id, title: "主会话的名字",
      updatedAt: 42, hasUnreadTurn: true, cwd: "/synthetic/project",
    }), status: Object.freeze({ inProgress: true }), key: `local:${id}`,
  });
  const a = task("side-one");
  const b = task("second");
  let index = persistence.readRegistry(storage);
  const projected = persistence.sidebarTask(index, a, identity);
  assert.equal(projected.summary.title, own.title, "full tab title must not be truncated again");
  assert.equal(persistence.sidebarTask(index, b, identity).summary.title, "Side chat 2");
  assert.strictEqual(projected.status, a.status);
  assert.equal(projected.key, a.key);
  assert.deepEqual({ ...projected.summary, title: a.summary.title }, a.summary);
  assert.equal(a.summary.title, "主会话的名字", "native catalog stays intact");
  for (const id of ["parent-one", "foreign", "other-user", "unsaved"]) {
    const native = task(id);
    assert.strictEqual(persistence.sidebarTask(index, native, identity), native);
  }
  const remote = { ...a, summary: { ...a.summary, hostId: "remote" } };
  assert.strictEqual(persistence.sidebarTask(index, remote, identity), remote);
  const cloud = { ...a, kind: "cloud" };
  assert.strictEqual(persistence.sidebarTask(index, cloud, identity), cloud);
  assert.strictEqual(persistence.sidebarTask(index, a, { ...identity, accountId: null }), a);
  const rows = persistence.summaryRows(index, [{ conversationId: "side-one", title: "stale tab" }], {
    ...identity, sourceConversationId: "parent-one",
  });
  assert.equal(rows.find(row => row.conversationId === "side-one").title, projected.summary.title);
  for (let i = 0; i < 100; i++) {
    assert.strictEqual(persistence.sidebarTask(index, a, identity), projected);
  }
  index = { ...index, records: { ...index.records, "side-one": {
    ...index.records["side-one"], durable: { ...own, title: "手动改名" },
  } } };
  const renamed = persistence.sidebarTask(index, a, identity);
  assert.notStrictEqual(renamed, projected);
  assert.equal(renamed.summary.title, "手动改名");
  assert.strictEqual(persistence.sidebarTask(structuredClone(index), a, identity), renamed,
    "unrelated native snapshot publications must not clone unchanged task projections");
  index = { ...index, records: { ...index.records, "side-one": {
    ...index.records["side-one"], deletion: { operationId: "delete", phase: "requested" },
  } } };
  assert.strictEqual(persistence.sidebarTask(index, a, identity), a);
});

test("native title adapters subscribe with the explicit family key and react to identity/title changes", () => {
  const storage = storageFixture();
  persistence.remember(storage, { ...durable(), title: "侧边标题" }, []);
  let index = persistence.readRegistry(storage);
  let account = "account-one";
  const reads = [];
  const modules = { SPnB: { chatGptAuthenticatedAccountId$: "account", o8: "user" } };
  const context = {
    __scp: persistence, n: id => modules[id],
    codexSidePatchRegistryAtom: () => "registry",
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL("../hooks/title-adapter.js", import.meta.url), "utf8"), context);
  /** Native family access distinguishes get(family) from get(family, undefined). */
  function get(...args) {
    reads.push(args);
    if (args[0] === "registry") { assert.equal(args.length, 2); return index; }
    return args[0] === "account" ? account : "user-one";
  }
  assert.equal(context.codexSidePatchTitle(get, "local", "side-one"), "侧边标题");
  assert.deepEqual(reads, [["registry", undefined], ["account"], ["user"]]);
  const task = { kind: "local", summary: {
    hostId: "local", conversationId: "side-one", title: "主会话",
  } };
  assert.equal(context.codexSidePatchSidebarTask(get, task).summary.title, "侧边标题");
  index = { ...index, records: { "side-one": {
    ...index.records["side-one"], durable: { ...durable(), title: "更新后的标题" },
  } } };
  assert.equal(context.codexSidePatchTitle(get, "local", "side-one"), "更新后的标题");
  account = "foreign";
  assert.equal(context.codexSidePatchTitle(get, "local", "side-one"), null);
  assert.strictEqual(context.codexSidePatchSidebarTask(get, task), task);
  reads.length = 0;
  assert.equal(context.codexSidePatchTitle(get, "remote", "side-one"), null);
  assert.strictEqual(context.codexSidePatchSidebarTask(get, { ...task, kind: "cloud" }).kind, "cloud");
  assert.equal(reads.length, 0);
});

test("final sidebar selector prefers the side tab title over nonempty native titles and reacts to changes", () => {
  const storage = storageFixture();
  const own = { ...durable(), title: "侧边标签自己的完整名字".repeat(10) };
  persistence.remember(storage, own, []);
  persistence.remember(storage, durable("foreign", "parent-one", "foreign-account"), []);
  persistence.remember(storage, { ...durable("other-user"), userId: "other-user" }, []);
  let index = persistence.readRegistry(storage);
  let account = "account-one";
  let user = "user-one";
  const reads = [];
  const nativeReads = [];
  const context = {
    __scp: persistence,
    n: () => ({ chatGptAuthenticatedAccountId$: "account", o8: "user" }),
    codexSidePatchRegistryAtom: () => "registry",
    nativeFallback: key => { nativeReads.push(key); return "主会话原生标题"; },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL("../hooks/title-adapter.js", import.meta.url), "utf8"), context);
  context.__side = { codexSidePatchTitle: context.codexSidePatchTitle };
  const hook = fs.readFileSync(new URL("../hooks/sidebar-title.js", import.meta.url), "utf8");
  vm.runInContext(`function finalTitle(e, {get:t}) {${hook}\nreturn nativeFallback(e);}`, context);
  /** Record native dependencies to verify saved titles react to registry and both identity atoms. */
  function get(...args) {
    reads.push(args);
    if (args[0] === "registry") { assert.equal(args.length, 2); return index; }
    return args[0] === "account" ? account : user;
  }
  /** FeCP gives this selector's non-null result priority over the projected catalog row title. */
  function rowTitle(id = "side-one", hostId = "local") {
    return context.finalTitle({ hostId, threadId: id }, { get }) ?? "catalog title";
  }
  assert.equal(rowTitle(), own.title);
  assert.equal(nativeReads.length, 0, "optimistic/catalog/live title paths must not override a side");
  assert.deepEqual(reads, [["registry", undefined], ["account"], ["user"]]);
  const tabRows = persistence.summaryRows(index, [{ conversationId: "side-one", title: "stale tab" }], {
    accountId: account, userId: user, sourceConversationId: "parent-one",
  });
  assert.equal(rowTitle(), tabRows.find(row => row.conversationId === "side-one").title,
    "left row and side tab must share the complete title");
  index = { ...index, records: { ...index.records, "side-one": {
    ...index.records["side-one"], durable: { ...own, title: "改名后的侧边标题" },
  } } };
  assert.equal(rowTitle(), "改名后的侧边标题");
  index = structuredClone(index);
  assert.equal(rowTitle(), "改名后的侧边标题", "persisted title survives renderer restart");
  for (const id of ["parent-one", "unsaved", "foreign", "other-user"]) {
    assert.equal(rowTitle(id), "主会话原生标题", "unowned threads retain native fallback");
  }
  account = null;
  assert.equal(rowTitle(), "主会话原生标题");
  account = "account-one";
  user = "other-user";
  assert.equal(rowTitle(), "主会话原生标题");
  user = "user-one";
  index = { ...index, records: { ...index.records, "side-one": {
    ...index.records["side-one"], deletion: { operationId: "delete", phase: "requested" },
  } } };
  assert.equal(rowTitle(), "主会话原生标题", "deletion must stop displaying the managed title");
  reads.length = 0;
  assert.equal(rowTitle("side-one", "remote"), "主会话原生标题");
  assert.equal(reads.length, 0, "remote title selection acquires no local registry dependencies");
  assert.equal(context.finalTitle(null, { get }), null);
  assert.equal(reads.length, 0, "null family keys preserve the native early return");
});

test("closed side chats survive restart and reopen by original ID without crossing accounts/parents", () => {
  const storage = storageFixture();
  persistence.remember(storage, durable(), ["parent-turn"]);
  persistence.remember(storage, durable("other-parent", "parent-two"), []);
  persistence.remember(storage, durable("other-account", "parent-one", "account-two"), []);
  persistence.hide(storage, "side-one");
  const restartedIndex = JSON.parse(JSON.stringify(persistence.readRegistry(storage)));
  const identity = {
    accountId: "account-one", userId: "user-one", sourceConversationId: "parent-one",
  };
  const rows = persistence.summaryRows(restartedIndex, [], identity);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].durable.conversationId, "side-one");
  assert.equal(rows[0].durable.hostId, "local");
  persistence.remember(storage, rows[0].durable);
  assert.deepEqual(persistence.readRegistry(storage).records["side-one"].inheritedTurnIds, ["parent-turn"]);
  assert.equal(persistence.readRegistry(storage).records["side-one"].hidden, false);
  assert.equal(persistence.summaryRows(restartedIndex, [rows[0]], identity).length, 1);
  assert.equal(persistence.isSavedSide(storage, "local", "side-one"), true);
  assert.equal(persistence.isSavedSide(storage, "remote-host", "side-one"), false);
  assert.equal(persistence.isManagedSide(storage, rows[0].durable), true);
  assert.equal(persistence.isManagedSide(storage, { ...rows[0].durable, hostId: "remote" }), false);
});

test("hot reads validate only new native snapshots and reject newly published corruption", () => {
  let validations = 0;
  const record = {
    durable: durable(), hidden: false,
    get inheritedTurnIds() { validations++; return ["parent-turn"]; },
  };
  let value = { version: 1, records: { "side-one": record } };
  const storage = { readValue: () => value };
  persistence.readRegistry(storage);
  const first = validations;
  for (let index = 0; index < 100; index++) {
    assert.equal(persistence.isSavedSide(storage, "local", "side-one"), true);
    assert.equal(persistence.isSavedSide(storage, "local", "parent-one"), false);
  }
  assert.equal(validations, first, "unchanged recents must not rescan inherited IDs");
  value = { version: 1, records: {
    "side-one": { durable: durable(), hidden: false, inheritedTurnIds: [42] },
  } };
  assert.throws(() => persistence.readRegistry(storage), /invalid record/);
  value = { version: 1, records: {} };
  assert.equal(persistence.isSavedSide(storage, "local", "side-one"), false);
  value = null;
  assert.strictEqual(persistence.readRegistry(storage), persistence.readRegistry(storage));
});

test("display caches preserve new boundaries and evict old sets instead of growing with saved history", () => {
  let value = { version: 1, records: {} };
  const storage = { readValue: () => value };
  const counts = Array(5).fill(0);
  /** Instrument membership construction while retaining normal native immutable array contents. */
  function boundary(index) {
    const ids = ["parent-" + index];
    ids[Symbol.iterator] = function* () {
      counts[index]++;
      yield* Array.prototype[Symbol.iterator].call(this);
    };
    return ids;
  }
  const turns = [{ turnId: "parent-0" }, { turnId: "own-side" }];
  for (let index = 0; index < 5; index++) {
    value.records["side-" + index] = {
      durable: durable("side-" + index), hidden: false, inheritedTurnIds: boundary(index),
    };
  }
  for (let index = 0; index < 5; index++) {
    persistence.presentationOptions(storage, { hostId: "local", id: "side-" + index },
      { conversationTurns: turns });
  }
  persistence.presentationOptions(storage, { hostId: "local", id: "side-4" },
    { conversationTurns: turns });
  assert.equal(counts[4], 1);
  persistence.presentationOptions(storage, { hostId: "local", id: "side-0" },
    { conversationTurns: turns });
  assert.equal(counts[0], 2, "fifth distinct boundary must evict the oldest retained set");
  value = { version: 1, records: {
    "side-0": { ...value.records["side-0"], inheritedTurnIds: ["own-side"] },
  } };
  const display = persistence.presentationOptions(storage, { hostId: "local", id: "side-0" },
    { conversationTurns: turns }).conversationTurns;
  assert.deepEqual(display.map(turn => turn.turnId), ["parent-0"]);
  const oversized = Array.from({ length: 20001 }, (_, index) => "large-" + index);
  let builds = 0;
  oversized[Symbol.iterator] = function* () {
    builds++;
    yield* Array.prototype[Symbol.iterator].call(this);
  };
  value = { version: 1, records: {
    "large": { durable: durable("large"), hidden: false, inheritedTurnIds: oversized },
  } };
  const largeTurns = [{ turnId: "large-20000" }, { turnId: "own-side" }];
  for (let index = 0; index < 2; index++) {
    assert.deepEqual(
      persistence.presentationOptions(storage, { hostId: "local", id: "large" },
        { conversationTurns: largeTurns }).conversationTurns
        .map(turn => turn.turnId), ["own-side"],
    );
  }
  assert.equal(builds, 2, "oversized sets work fully but are never retained in the cache");
});

test("unchanged relation writes are skipped and parent discovery reuses only the current snapshot", () => {
  let value;
  let writes = 0;
  const storage = {
    readValue: () => value,
    writeValue: (_, updated) => { value = updated; writes++; },
  };
  const descriptor = durable();
  persistence.remember(storage, descriptor, ["parent-turn"]);
  persistence.remember(storage, { ...descriptor });
  persistence.remember(storage, { ...descriptor }, ["parent-turn"]);
  assert.equal(writes, 1);
  persistence.hide(storage, "side-one");
  persistence.hide(storage, "side-one");
  assert.equal(writes, 2);
  persistence.remember(storage, descriptor);
  assert.equal(writes, 3, "reopening a hidden row must remain a real write");
  persistence.remember(storage, { ...descriptor, title: "changed" });
  assert.equal(writes, 3, "stale reopening titles must not replace the saved name or write again");
  assert.equal(persistence.readRegistry(storage).records["side-one"].durable.title, "side-one");
  const identity = {
    accountId: "account-one", userId: "user-one", sourceConversationId: "parent-one",
  };
  const originalRows = [{ conversationId: "side-one" }];
  const enriched = persistence.summaryRows(value, originalRows, identity);
  assert.equal(enriched[0].durable.conversationId, "side-one");
  assert.equal(enriched[0].isSavedClosed, false);
  assert.equal(originalRows[0].durable, undefined, "native input rows must remain immutable");
  const empty = [];
  assert.strictEqual(persistence.summaryRows(value, empty, {
    ...identity, sourceConversationId: "other-parent",
  }), empty);
  persistence.summaryRows(value, empty, identity);
  persistence.remember(storage, durable("new-side"), []);
  value = { ...value, records: { ...value.records, "new-side": {
    ...value.records["new-side"], createdAt: value.records["side-one"].createdAt + 1,
  } } };
  assert.deepEqual(persistence.summaryRows(value, empty, identity).map(row => row.conversationId),
    ["new-side", "side-one"]);
});

test("side chat discovery sorts open, closed and native-only rows by creation without mutating input", () => {
  const identity = {
    accountId: "account-one", userId: "user-one", sourceConversationId: "parent-one",
  };
  /** Fixed millisecond timestamps make creation/activity differences independent of wall time. */
  const record = (id, createdAt, options = {}) => Object.freeze({
    durable: Object.freeze(durable(id)), createdAt, updatedAt: 9000,
    inheritedTurnIds: Object.freeze([]), hidden: true, ...options,
  });
  const index = Object.freeze({ version: 1, records: Object.freeze({
    oldest: record("oldest", 1000, { hidden: false, updatedAt: 999999 }),
    newest: record("newest", 5000),
    tied: record("tied", 3000),
    unknown: record("unknown", undefined),
    foreign: record("foreign", 10000, { durable: durable("foreign", "parent-one", "other-account") }),
    "other-user": record("other-user", 10000, { durable: { ...durable("other-user"), userId: "other-user" } }),
    "other-parent": record("other-parent", 10000, { durable: durable("other-parent", "other-parent") }),
  }) });
  const nativeRows = Object.freeze([
    Object.freeze({ conversationId: "oldest", createdAt: 99999, isResponseInProgress: true }),
    Object.freeze({ conversationId: "native", createdAt: 3000, hasUnreadTurn: true }),
    Object.freeze({ conversationId: "no-time" }),
  ]);
  const rows = persistence.summaryRows(index, nativeRows, identity);
  assert.deepEqual(rows.map(row => row.conversationId),
    ["newest", "native", "tied", "oldest", "no-time", "unknown"]);
  assert.equal(rows[3].createdAt, 1000, "saved creation time overrides newer native metadata");
  assert.equal(rows[3].isResponseInProgress, true);
  assert.strictEqual(rows[1], nativeRows[1], "native metadata and reference remain intact");
  assert.equal(nativeRows[0].createdAt, 99999);
  for (const unavailableIndex of [null, { version: 1, records: {} }]) {
    const sorted = persistence.summaryRows(unavailableIndex, nativeRows, identity);
    assert.deepEqual(sorted.map(row => row.conversationId), ["oldest", "native", "no-time"]);
    assert.strictEqual(sorted, nativeRows, "an ordered native input keeps its reference");
    const reverse = Object.freeze([...nativeRows].reverse());
    assert.deepEqual(persistence.summaryRows(unavailableIndex, reverse, identity), sorted);
    assert.equal(reverse[0].conversationId, "no-time");
  }
  const invalid = [
    { conversationId: "nan", createdAt: NaN },
    { conversationId: "infinite", createdAt: Infinity },
    { conversationId: "string", createdAt: "9999" },
    { conversationId: "zero", createdAt: 0 },
    { conversationId: "negative", createdAt: -1 },
    { conversationId: "known", createdAt: 1 },
  ];
  assert.deepEqual(persistence.summaryRows(null, invalid, identity).map(row => row.conversationId),
    ["known", "nan", "infinite", "string", "zero", "negative"]);
});

test("closing, renaming and reopening a saved side chat preserve its creation order across restart", () => {
  const storage = storageFixture();
  const identity = {
    accountId: "account-one", userId: "user-one", sourceConversationId: "parent-one",
  };
  persistence.remember(storage, durable("older"), []);
  persistence.remember(storage, durable("newer"), []);
  const index = persistence.readRegistry(storage);
  storage.writeValue(persistence.REGISTRY_KEY, { ...index, records: {
    older: { ...index.records.older, createdAt: 1000 },
    newer: { ...index.records.newer, createdAt: 2000 },
  } });
  persistence.hide(storage, "older");
  const hidden = persistence.readRegistry(storage);
  assert.equal(hidden.records.older.createdAt, 1000);
  storage.writeValue(persistence.REGISTRY_KEY, { ...hidden, records: {
    ...hidden.records, older: { ...hidden.records.older,
      durable: { ...hidden.records.older.durable, title: "renamed after newer was created" },
    },
  } });
  persistence.remember(storage, durable("older"));
  const restarted = structuredClone(persistence.readRegistry(storage));
  const rows = persistence.summaryRows(restarted, [{ conversationId: "older" }], identity);
  assert.deepEqual(rows.map(row => row.conversationId), ["newer", "older"]);
  assert.equal(rows[1].title, "renamed after newer was created");
  assert.equal(restarted.records.older.createdAt, 1000);
  assert.ok(restarted.records.older.updatedAt > restarted.records.newer.createdAt);
});

test("actual summary hook reads the native KV family with a key and preserves reactive open/saved rows", () => {
  const storage = storageFixture();
  persistence.remember(storage, durable("closed-side"), []);
  persistence.hide(storage, "closed-side");
  const registryFamily = { kind: "signal-family" };
  const accountSignal = {}, userSignal = {};
  let account = "account-one";
  const context = {
    __scp: persistence,
    n: (id) => ({
      V7mA: { codexSidePatchRegistryAtom: () => registryFamily },
      SPnB: { chatGptAuthenticatedAccountId$: accountSignal, o8: userSignal },
    })[id],
  };
  const selector = vm.runInNewContext(
    fs.readFileSync(new URL("../hooks/summary.js", import.meta.url), "utf8"), context,
  );
  /** Model native one-argument atom reads and two-argument family reads, including undefined keys. */
  function get(signal, key) {
    if (signal === registryFamily) {
      assert.equal(arguments.length, 2, "native KV families require an explicit key argument");
      assert.equal(key, undefined);
      return persistence.readRegistry(storage);
    }
    if (signal === accountSignal) return account;
    if (signal === userSignal) return "user-one";
    throw Error("Unknown fixture signal");
  }
  const scope = { value: { conversationId: "parent-one" } };
  const nativeRows = [{
    conversationId: "live-side", tabId: "sidechat:live-side", isResponseInProgress: true,
    createdAt: Date.now() + 1000,
    hasUnreadTurn: true, savedThread: { hostId: "local", threadId: "live-side" },
  }];
  const rows = selector({ get, scope }, nativeRows);
  assert.deepEqual(Array.from(rows, row => row.conversationId), ["live-side", "closed-side"]);
  assert.equal(rows[0].isResponseInProgress, true);
  assert.strictEqual(rows[0], nativeRows[0], "native attached-chat row and metadata stay intact");
  account = "account-two";
  assert.deepEqual(Array.from(selector({ get, scope }, nativeRows), row => row.conversationId), ["live-side"]);
  account = "account-one";
  persistence.remember(storage, durable("second-side"), []);
  assert.equal(selector({ get, scope }, nativeRows).length, 3);
});

test("unified presentation hides inherited history while canonical context stays intact", () => {
  const storage = storageFixture();
  persistence.remember(storage, durable(), ["parent-old", "parent-new"]);
  const turns = [
    { turnId: "parent-old", items: [{ type: "userMessage", text: "parent" }] },
    { turnId: "side-first", items: [{ type: "agentMessage", text: "side" }] },
    { turnId: "parent-new", items: [{ type: "agentMessage", text: "parent" }] },
    { turnId: "side-pending", items: [{ type: "imageGeneration", src: "side-attachment" }] },
  ];
  const before = structuredClone(turns);
  const options = {
    conversationTurns: turns,
    turnEntityKeys: ["entity-p1", "entity-s1", "entity-p2", "entity-s2"],
    historyEntriesByTurnIndex: turns.map((_, index) => ({
      entityKey: `entity-${index}`, positionKey: `position-${index}`,
    })),
    historyTimeline: [
      { type: "gap", key: "pagination-gap" },
      ...turns.map((_, index) => ({
        type: "content", key: `position-${index}`, value: `entity-${index}`,
      })),
    ],
    parentConversationTurns: turns, subagentParentThreadId: "parent-one",
  };
  const view = persistence.presentationOptions(storage, { id: "side-one", hostId: "local" }, options);
  assert.deepEqual(view.conversationTurns.map((turn) => turn.turnId), ["side-first", "side-pending"]);
  assert.deepEqual(view.turnEntityKeys, ["entity-s1", "entity-s2"]);
  assert.deepEqual(view.historyTimeline.map((entry) => entry.key),
    ["pagination-gap", "position-1", "position-3"]);
  assert.deepEqual(turns, before);
  assert.equal(options.historyTimeline.length, 5);
  assert.equal(view.subagentParentThreadId, null);
  for (const conversation of [
    { id: "parent-one", hostId: "local" }, { id: "side-one", hostId: "remote" },
  ]) {
    assert.strictEqual(persistence.presentationOptions(storage, conversation, options), options);
  }
});

test("first side send preserves live admission and hidden partial history without mutating native state", () => {
  const storage = storageFixture();
  const inheritedIds = Array.from({ length: 63 }, (_, index) => `parent-${index}`);
  persistence.remember(storage, durable(), inheritedIds);
  /** Loaded parent summaries retain incomplete cursors while the first side turn is admitted. */
  const inherited = inheritedIds.map(turnId => Object.freeze({
    turnId, items: Object.freeze([]),
    itemsPagination: Object.freeze({ hasLoadedOldest: false, olderCursor: `items:${turnId}` }),
  }));
  const pending = Object.freeze({
    turnId: null, pendingUserMessageAdmission: true,
    params: Object.freeze({ clientUserMessageId: "first-message", input: ["first"] }),
    items: Object.freeze([{ type: "userMessage", clientId: "first-message" }]),
  });
  const active = Object.freeze({
    turnId: "side-first", status: "inProgress", params: pending.params,
    items: Object.freeze([{ type: "agentMessage", text: "streaming" }]),
  });
  for (const live of [[pending], [pending, active], [active]]) {
    const turns = Object.freeze([...inherited, ...live]);
    const view = persistence.presentationOptions(storage, { id: "side-one", hostId: "local" },
      { conversationTurns: turns });
    assert.deepEqual(view.conversationTurns, live);
    live.forEach((turn, index) => assert.strictEqual(view.conversationTurns[index], turn));
    assert.equal(turns.length, 63 + live.length);
    assert.ok(inherited.every(turn => turn.itemsPagination.hasLoadedOldest === false));
  }
});

test("side history gaps and partial own turns remain pageable across incomplete and complete snapshots", () => {
  const storage = storageFixture();
  persistence.remember(storage, durable(), ["parent-last"]);
  /** A gap between side turns represents omitted side history and must never be hidden. */
  const olderSide = { turnId: "side-old", items: [],
    itemsPagination: { hasLoadedOldest: false, olderCursor: "older-items" } };
  const newestSide = { turnId: "side-new", items: [] };
  const gap = Object.freeze({
    type: "gap", key: "missing-side-history",
    newerBoundaryRef: Object.freeze({ handle: { cursor: "older-side-turns" } }),
  });
  const options = {
    conversationTurns: [{ turnId: "parent-last", items: [] }, olderSide, newestSide],
    historyEntriesByTurnIndex: [
      { positionKey: "parent", entityKey: "turn:parent-last" },
      { positionKey: "old", entityKey: "turn:side-old" },
      { positionKey: "new", entityKey: "turn:side-new" },
    ],
    historyTimeline: [
      { type: "content", key: "parent", value: "turn:parent-last" },
      { type: "content", key: "old", value: "turn:side-old" }, gap,
      { type: "content", key: "new", value: "turn:side-new" },
    ],
  };
  const before = structuredClone(options);
  const view = persistence.presentationOptions(storage, { id: "side-one", hostId: "local" }, options);
  assert.deepEqual(view.historyTimeline.map(entry => entry.key), ["old", "missing-side-history", "new"]);
  assert.strictEqual(view.historyTimeline[1], gap);
  assert.strictEqual(view.conversationTurns[0].itemsPagination, olderSide.itemsPagination);
  assert.deepEqual(options, before);
  olderSide.itemsPagination = { hasLoadedOldest: true, olderCursor: null };
  const complete = persistence.presentationOptions(storage, { id: "side-one", hostId: "local" },
    { ...options, historyTimeline: options.historyTimeline.filter(entry => entry !== gap) });
  assert.deepEqual(complete.conversationTurns.map(turn => turn.turnId), ["side-old", "side-new"]);
  assert.equal(complete.conversationTurns[0].itemsPagination.hasLoadedOldest, true);
  assert.equal(complete.historyTimeline.length, 2);
});

test("prompt rail removes all inherited placeholders while retaining native completion and errors", () => {
  const storage = storageFixture();
  persistence.remember(storage, durable(), ["parent-old", "parent-new"]);
  const items = Object.freeze(["parent-old", "parent-new"].map((turnId, index) =>
    Object.freeze({ turnId, pageBackwardsCursor: "native-page", descendingOffset: index })));
  for (const complete of [false, true]) {
    const error = Error("native refresh failed");
    const query = Object.freeze({
      data: Object.freeze({ items, complete }), error, isFetching: true, status: "success",
    });
    const view = persistence.navigationHistoryQuery(storage, { id: "side-one", hostId: "local" }, query);
    assert.deepEqual(view.data.items, []);
    assert.equal(view.data.complete, complete);
    assert.strictEqual(view.error, error);
    assert.equal(view.isFetching, true);
    assert.equal(view.status, "success");
    assert.strictEqual(query.data.items, items);
    assert.equal(query.data.items.length, 2, "native history metadata remains complete");
  }
});

test("prompt rail retains unloaded side turns and exact native preview/reveal cursor offsets", () => {
  const storage = storageFixture();
  persistence.remember(storage, durable(), ["parent-old", "parent-recent"]);
  const items = Object.freeze([
    Object.freeze({ turnId: "parent-old", pageBackwardsCursor: "older-page", descendingOffset: 8 }),
    Object.freeze({ turnId: "side-unloaded", pageBackwardsCursor: "older-page", descendingOffset: 7 }),
    Object.freeze({ turnId: "parent-recent", pageBackwardsCursor: "latest-page", descendingOffset: 3 }),
    Object.freeze({ turnId: "side-loaded", pageBackwardsCursor: "latest-page", descendingOffset: 2 }),
    Object.freeze({ turnId: "side-newest", pageBackwardsCursor: "latest-page", descendingOffset: 0 }),
  ]);
  const query = Object.freeze({ data: Object.freeze({ items, complete: true }), isFetching: false });
  const view = persistence.navigationHistoryQuery(storage, { id: "side-one", hostId: "local" }, query);
  assert.deepEqual(view.data.items.map(item => item.turnId), ["side-unloaded", "side-loaded", "side-newest"]);
  [1, 3, 4].forEach((index, position) => assert.strictEqual(view.data.items[position], items[index]));
  assert.strictEqual(view.data.items.find(item => item.turnId === "side-unloaded"), items[1]);
  assert.equal(view.data.items.find(item => item.turnId === "parent-old"), undefined);
  assert.deepEqual(view.data.items.map(item => item.descendingOffset), [7, 2, 0]);
  assert.equal(query.data.items.length, 5);
});

test("prompt rail leaves ordinary, remote, loading and unaffected query snapshots unchanged", () => {
  const storage = storageFixture();
  persistence.remember(storage, durable(), ["parent-turn"]);
  persistence.remember(storage, durable("empty-boundary"), []);
  const query = { data: { items: [{ turnId: "side-first", descendingOffset: 9 }], complete: false } };
  for (const conversation of [
    { id: "side-one", hostId: "local" }, { id: "parent-one", hostId: "local" },
    { id: "empty-boundary", hostId: "local" }, { id: "side-one", hostId: "remote" },
  ]) {
    assert.strictEqual(persistence.navigationHistoryQuery(storage, conversation, query), query);
  }
  const unreadable = { readValue: () => { throw Error("should not read registry"); } };
  for (const data of [undefined, null]) {
    const loading = { data, status: "pending" };
    assert.strictEqual(persistence.navigationHistoryQuery(unreadable,
      { id: "side-one", hostId: "local" }, loading), loading);
  }
  const remote = { data: { items: [{ turnId: "parent-turn" }], complete: true } };
  assert.strictEqual(persistence.navigationHistoryQuery(unreadable,
    { id: "side-one", hostId: "remote" }, remote), remote);
});

test("prompt rail uses published boundaries and newly fetched metadata without changing old snapshots", () => {
  const storage = storageFixture();
  const conversation = { id: "side-one", hostId: "local" };
  persistence.remember(storage, durable(), ["parent-turn"]);
  const query = { data: { items: [{ turnId: "parent-turn" }, { turnId: "side-first" }], complete: false } };
  const first = persistence.navigationHistoryQuery(storage, conversation, query);
  const refreshed = { data: { ...query.data, items: [...query.data.items, { turnId: "side-second" }],
    complete: true } };
  assert.deepEqual(persistence.navigationHistoryQuery(storage, conversation, refreshed).data.items
    .map(item => item.turnId), ["side-first", "side-second"]);
  persistence.remember(storage, durable(), ["parent-turn", "side-first"]);
  const updated = persistence.navigationHistoryQuery(storage, conversation, refreshed);
  assert.deepEqual(updated.data.items.map(item => item.turnId), ["side-second"]);
  assert.deepEqual(first.data.items.map(item => item.turnId), ["side-first"]);
  assert.equal(first.data.complete, false);
  assert.equal(updated.data.complete, true);
  assert.equal(query.data.items.length, 2);
});

test("boundary reads all pages without transcript bodies and fails on cancellation/cursor loops", async () => {
  const received = [];
  const boundary = await persistence.inheritedBoundary(async (_, params) => {
    received.push(params);
    return params.cursor == null
      ? { data: Array.from({ length: 100 }, (_, id) => ({ id: `turn-${id}` })), nextCursor: "next" }
      : { data: [{ id: "turn-100" }], nextCursor: null };
  }, "side-one", () => {});
  assert.equal(boundary.length, 101);
  assert.equal(received[0].itemsView, "notLoaded");
  let requests = 0;
  await assert.rejects(persistence.inheritedBoundary(async () => {
    requests++;
    return { data: [], nextCursor: "loop" };
  }, "side-one", () => {}), /cursor repeated/);
  assert.equal(requests, 2);
  await assert.rejects(persistence.inheritedBoundary(() => {
    throw Error("must not call");
  }, "side-one", () => { throw Error("cancelled"); }), /cancelled/);
});

test("RPC finally records full request, response and non-enumerable error fields", async () => {
  const lines = [];
  const params = { nested: { text: "忠实 JSON" }, nullable: null, array: [1, false] };
  const response = { result: { originalId: "side-one" } };
  assert.deepEqual(await persistence.loggedRpc("native/method", params, async () => {
    params.nested.text = "mutation after send";
    return response;
  }, (line) => lines.push(line)), response);
  const success = JSON.parse(lines[0]);
  assert.equal(success.request.nested.text, "忠实 JSON");
  assert.deepEqual(success.response, response);
  assert.equal(success.error, null);
  const error = Object.assign(Error("native failure"), { code: -32000, data: { detail: "exact" } });
  await assert.rejects(persistence.loggedRpc("native/method", {}, () => {
    throw error;
  }, (line) => lines.push(line)), /native failure/);
  const failure = JSON.parse(lines[1]);
  assert.equal(failure.error.message, "native failure");
  assert.deepEqual(failure.error.data, { detail: "exact" });
  assert.equal(failure.error.code, -32000);
  assert.ok(failure.error.stack.includes("native failure"));
});

/** A native facade can own private fields and asynchronous handles across renderer guards. */
test("renderer RPC guard blocks pending and completed deletions while preserving native receivers", async () => {
  const storage = storageFixture();
  const descriptor = durable();
  persistence.remember(storage, descriptor, []);
  const calls = [];
  const result = Promise.resolve({ native: "unchanged" });
  class NativeRpc {
    /** Private state catches any accidental invocation with the proxy as the native receiver. */
    #active = true;
    sendRequest(...args) { calls.push([this.#active, "sendRequest", ...args]); return result; }
    resumeConversation(...args) { calls.push([this.#active, "resumeConversation", ...args]); return result; }
    startTurn(...args) { calls.push([this.#active, "startTurn", ...args]); return result; }
    subscribe(...args) { calls.push([this.#active, "subscribe", ...args]); return result; }
    dup() { calls.push([this.#active, "dup"]); return new NativeRpc(); }
    [Symbol.dispose]() { calls.push([this.#active, "dispose"]); this.#active = false; }
  }
  const native = new NativeRpc();
  const rpc = persistence.guardedSideRpc(storage, "local", native);
  assert.strictEqual(persistence.guardedSideRpc(storage, "local", native), rpc);
  assert.strictEqual(persistence.guardedSideRpc(storage, "remote-host", native), native);
  assert.strictEqual(rpc.sendRequest, rpc.sendRequest);
  assert.strictEqual(rpc.subscribe, rpc.subscribe);
  assert.strictEqual(rpc.sendRequest("turn/start", { threadId: descriptor.conversationId }), result);
  assert.strictEqual(rpc.resumeConversation({ conversationId: descriptor.conversationId }), result);
  assert.strictEqual(rpc.subscribe({ type: "event" }), result);
  const duplicate = rpc.dup();
  const index = persistence.readRegistry(storage);
  storage.writeValue(persistence.REGISTRY_KEY, {
    ...index, records: { ...index.records, [descriptor.conversationId]: {
      ...index.records[descriptor.conversationId],
      deletion: { operationId: "pending-operation", phase: "requested" },
    } },
  });
  const count = calls.length;
  assert.throws(() => rpc.sendRequest("turn/steer", { threadId: descriptor.conversationId }), /deleted/);
  assert.throws(() => rpc.resumeConversation({ conversationId: descriptor.conversationId }), /deleted/);
  assert.throws(() => rpc.startTurn(descriptor.conversationId, { input: [] }), /deleted/);
  assert.throws(() => duplicate.startTurn({ threadId: descriptor.conversationId }), /deleted/);
  assert.equal(calls.length, count, "blocked operations never reach the native worker");
  assert.strictEqual(rpc.sendRequest("thread/delete", { threadId: descriptor.conversationId }), result);
  assert.strictEqual(rpc.startTurn({ conversationId: "ordinary-thread" }), result);
  storage.writeValue(persistence.REGISTRY_KEY, { version: 1, records: {} });
  storage.writeValue(persistence.DELETED_KEY, { [descriptor.conversationId]: true });
  assert.throws(() => rpc.sendRequest("thread/resume", { threadId: descriptor.conversationId }), /deleted/);
  duplicate[Symbol.dispose]();
  rpc[Symbol.dispose]();
  assert.equal(calls.at(-1)[1], "dispose");
  assert.ok(calls.every(call => call[0] === true), "native private receivers survive every wrapper");
});

test("RPC guard invokes callable proxies without extending bind/apply paths or replacing handles", () => {
  const storage = storageFixture();
  const calls = [];
  const handle = Object.freeze({ then() {}, cancel() {}, [Symbol.dispose]() {} });
  /** Emulate native callable properties whose .bind/.apply/.call access creates a remote RPC path. */
  const method = (name, invoke) => new Proxy(function () {}, {
    get(_, property) {
      if (typeof property === "string") throw Error(`Unexpected remote path ${name}.${property}`);
    },
    apply(_, receiver, args) {
      assert.strictEqual(receiver, native);
      calls.push([name, args]);
      return invoke?.(...args) ?? handle;
    },
  });
  const native = {
    resumeConversation: method("resumeConversation"),
    ensureConversationFirstPage: method("ensureConversationFirstPage"),
    findPinnedThreadIds: method("findPinnedThreadIds"),
    listMcpServers: method("listMcpServers"),
    sendRequest: method("sendRequest"),
    subscribe: method("subscribe"),
    dup: method("dup", () => native),
    [Symbol.dispose]: method("dispose"),
  };
  const rpc = persistence.guardedSideRpc(storage, "local", native);
  for (const name of ["resumeConversation", "ensureConversationFirstPage", "findPinnedThreadIds",
    "listMcpServers", "subscribe"]) {
    assert.strictEqual(rpc[name], rpc[name]);
    assert.strictEqual(rpc[name]({ conversationId: "ordinary-main" }), handle);
  }
  assert.strictEqual(rpc.sendRequest("thread/resume", { threadId: "ordinary-main" }), handle);
  assert.strictEqual(rpc.dup(), rpc);
  storage.writeValue(persistence.DELETED_KEY, { "deleted-side": true });
  const before = calls.length;
  assert.throws(() => rpc.resumeConversation({ conversationId: "deleted-side" }), /deleted/);
  assert.throws(() => rpc.sendRequest("turn/start", { threadId: "deleted-side" }), /deleted/);
  assert.equal(calls.length, before);
  rpc[Symbol.dispose]();
  assert.equal(calls.at(-1)[0], "dispose");
});

/**
 * Evaluate the actual version adapter's creation function with native API-shaped services.
 * The fixture records side-boundary policy, persistent fork flags and cancelled-thread cleanup.
 */
function creationFixture(hostId = "local", attached = false) {
  const storage = storageFixture();
  const requests = [];
  let account = "account-one";
  let pending = true;
  const context = {
    __scp: persistence,
    __side: { codexSidePatchStorage: () => storage },
    __sideIdentity: {
      chatGptAuthenticatedAccountId$: "account",
      o8: "user",
    },
    r: { ZJQ: () => false },
    h: { z: async () => null },
    d: { c: (_, result) => Error(result.status) },
    c: { A: async () => ["/empty-workspace"] },
    l: { Y: async () => ({ instructions: "Native instructions" }) },
    u: { c: () => false },
    p: { e2: "detail" },
    i: { sX: "history" },
    a: { JF: () => attached },
    s: { B: "host" },
    m: { JW: "gate" },
    f: { R: "Untrusted parent is reference only" },
    Ce: async (_, host, params) => {
      requests.push({ method: "fork", host, params });
      return {
        conversationId: "side-one", ephemeral: params.ephemeral ?? false,
        synchronization: { status: "complete" },
      };
    },
    __sideManager: { V: () => ({
      sendRequest: async (method, params) => {
        requests.push({ method, params });
        return { data: [{ id: "parent-turn" }], nextCursor: null };
      },
      archiveConversation: async (id, options) => requests.push({ method: "archive", id, options }),
    }) },
    Error, Promise,
  };
  context.o = { y: (...args) => context.Ce(...args) };
  context.__require = id => ({
    DBCl: context.r, gjB6: context.h, lqHG: context.d, MLeN: context.c,
    v3eX: context.l, KJlv: context.u, qixt: context.p, Ehlj: context.a,
    tl5a: context.i, CfsC: context.s, OMIV: context.m, IhcX: context.o,
    TJeR: context.f, SPnB: context.__sideIdentity, Dgwo: context.__sideManager,
    V7mA: context.__side,
  })[id];
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL("../hooks/local-create.js", import.meta.url), "utf8"), context);
  return {
    invoke: () => context.codexSideCreate({
      scope: { get: (atom) => atom === "account" ? account : atom === "user" ? "user-one" :
        atom === "history" ? "paginated" : atom === "gate" ? attached : false },
      threadSource: "user",
      sourceConversationId: "parent-one", cwd: "/empty-workspace", hostId,
      parentNavigationPath: "/thread/parent-one", collaborationMode: undefined,
      assertRequestCurrent: () => { if (!pending) throw Error("cancelled"); },
    }),
    storage, requests, context,
    changeAccount: () => { account = "account-two"; },
    cancel: () => { pending = false; },
  };
}

test("actual native creation hook creates a durable local fork with inherited-ID display boundary", async () => {
  const fixture = creationFixture();
  const result = await fixture.invoke();
  assert.equal(result.durable.conversationId, "side-one");
  assert.equal(result.durable.hostId, "local");
  assert.equal(result.durable.collaborationMode, null);
  assert.equal(fixture.requests[0].params.ephemeral, false);
  assert.equal(fixture.requests[0].params.sideConversation, true);
  assert.match(fixture.requests[0].params.developerInstructions, /reference only/);
  assert.deepEqual(persistence.readRegistry(fixture.storage).records["side-one"].inheritedTurnIds,
    ["parent-turn"]);
});

/** Model and effort must follow the updated native fork contract for both local and remote hosts. */
test("creation forwards native collaboration model and effort without replacing the mode", async () => {
  for (const host of ["local", "remote-host"]) {
    for (const effort of ["high", null]) {
      const fixture = creationFixture(host);
      const mode = { settings: { model: "native-model", reasoning_effort: effort } };
      await fixture.context.codexSideCreate({
        scope: { get: atom => atom === "account" ? "account-one" :
          atom === "user" ? "user-one" : false },
        sourceConversationId: "parent-one", threadSource: "user", hostId: host,
        cwd: "/empty-workspace", collaborationMode: mode,
      });
      assert.strictEqual(fixture.requests[0].params.collaborationMode, mode);
      assert.equal(fixture.requests[0].params.model, "native-model");
      assert.equal(fixture.requests[0].params.reasoningEffort, effort);
    }
  }
});

test("cancelled and identity-retired native creations are archived without recoverable orphan rows", async () => {
  for (const retire of ["cancel", "changeAccount"]) {
    const fixture = creationFixture();
    fixture.context.Ce = async () => {
      fixture[retire]();
      return { conversationId: "side-one", synchronization: { status: "complete" } };
    };
    await assert.rejects(fixture.invoke(), /cancelled|identity changed/);
    assert.equal(fixture.requests.filter((request) => request.method === "archive").length, 1);
    assert.deepEqual(persistence.readRegistry(fixture.storage).records, {});
  }
  const fixture = creationFixture();
  fixture.storage.writeValue(persistence.REGISTRY_KEY, { version: 99, records: {} });
  await assert.rejects(fixture.invoke(), /unsupported format/);
  assert.equal(fixture.requests.at(-1).method, "archive");
  assert.equal(fixture.storage.readValue(persistence.REGISTRY_KEY).version, 99);
});

test("remote creation retains the native temporary fork and creates no local saved relation", async () => {
  const fixture = creationFixture("remote-host");
  const result = await fixture.invoke();
  assert.equal(result.durable, undefined);
  assert.equal(fixture.requests[0].host, "remote-host");
  assert.equal(fixture.requests[0].params.ephemeral, true);
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(persistence.readRegistry(fixture.storage).records, {});
});

/** The new native capability flag must remain effective for hosts outside local plugin storage. */
test("remote attached creation preserves native persistence without a plugin registry record", async () => {
  const fixture = creationFixture("remote-host", true);
  const result = await fixture.invoke();
  assert.equal(result.persistent, true);
  assert.equal(result.durable, undefined);
  assert.equal(fixture.requests[0].params.attachToSource, true);
  assert.equal(fixture.requests[0].params.ephemeral, undefined);
  assert.doesNotMatch(fixture.requests[0].params.developerInstructions, /temporary side chats/);
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(persistence.readRegistry(fixture.storage).records, {});
});

/**
 * Run the actual restoration adapter against account checks and native resume services.
 * Both asynchronous boundaries can retire the identity, without archiving an existing thread.
 */
function restorationFixture(changeAt) {
  let account = "account-one";
  const requests = [];
  const storage = storageFixture();
  const descriptor = { ...durable(), patchVersion: 1 };
  persistence.remember(storage, descriptor, []);
  const context = {
    __scp: persistence,
    __side: { codexSidePatchStorage: () => storage },
    a: { iwv: "local", ZJQ: () => false, Rt_: error => error.message },
    d: { chatGptAuthenticatedAccountId$: "account", o8: "user" },
    g: (_, descriptor) => persistence.assertIdentity(descriptor, account, "user-one"),
    l: { A: async () => {
      if (changeAt === "root-error") throw Error("Native workspace access failed");
      if (changeAt === "roots") account = "account-two";
      if (changeAt === "delete-roots") persistence.forgetCancelled(storage, "side-one");
      return ["/empty-workspace"];
    } },
    s: { V: (_, host) => ({
      resumeConversation: async (params, options) => {
        requests.push({ host, params, options });
        if (changeAt === "resume") account = "account-two";
        if (changeAt === "delete-resume") persistence.forgetCancelled(storage, "side-one");
        return { status: "ready" };
      },
    }) },
    i: { jQ: () => true },
    o: { uZ: Error },
    Error,
  };
  context.__require = id => ({
    DBCl: context.a, SPnB: context.d, MLeN: context.l, Dgwo: context.s,
    shRG: context.i, vpsD: context.o, V7mA: context.__side, svjy: { g: "intl" },
  })[id];
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL("../hooks/restore.js", import.meta.url), "utf8"), context);
  return {
    invoke: () => context.codexSideRestore({
      get: (key) => key === "account" ? account : key === "intl"
        ? { formatMessage: () => "The signed-in identity changed" } : "user-one",
    }, descriptor, "parent-one", "/thread/parent-one"),
    requests, storage,
  };
}

test("actual restore uses the original local ID and preserves native configuration", async () => {
  const fixture = restorationFixture();
  const result = await fixture.invoke();
  assert.equal(result.conversationId, "side-one");
  assert.equal(result.hostId, "local");
  assert.equal(fixture.requests[0].host, "local");
  assert.equal(fixture.requests[0].params.preserveServerConfiguration, true);
  assert.equal(fixture.requests[0].options.readResumeInputs, true);
  assert.equal(fixture.requests[0].params.sideConversation.parentNavigationPath, "/thread/parent-one");
});

test("restore and final panel acceptance reject identity changes across asynchronous preparation", async () => {
  for (const boundary of ["roots", "resume"]) {
    const fixture = restorationFixture(boundary);
    await assert.rejects(fixture.invoke(), /identity changed/);
    assert.equal(fixture.requests.length, boundary === "roots" ? 0 : 1);
  }
  assert.throws(() => persistence.assertIdentity(durable(), "account-two", "user-one"), /identity changed/);
  assert.throws(() => persistence.assertIdentity(durable(), "account-one", "other-user"), /identity changed/);
  assert.doesNotThrow(() => persistence.assertIdentity(undefined, "account-two", "user-one"));
});

test("workspace failure retains the native retryable restore result without starting resume", async () => {
  const fixture = restorationFixture("root-error");
  const result = await fixture.invoke();
  assert.equal(result.durable.conversationId, "side-one");
  assert.equal(result.setupError.message, "Native workspace access failed");
  assert.equal(fixture.requests.length, 0);
});

test("actual restore rejects deletion during workspace lookup or native resume without recreating a row", async () => {
  for (const boundary of ["delete-roots", "delete-resume"]) {
    const fixture = restorationFixture(boundary);
    await assert.rejects(fixture.invoke(), /deleted/);
    assert.equal(fixture.requests.length, boundary === "delete-roots" ? 0 : 1);
    assert.equal(persistence.readRegistry(fixture.storage).records["side-one"], undefined);
  }
});

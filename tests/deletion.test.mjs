/** Destructive behavior is verified with synthetic native IDs and state files outside Git. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import state from "../runtime/main-state.cjs";
import * as runtime from "../runtime/persistence.mjs";

/** Synthetic ownership descriptors make parent and other-account protection observable. */
function durable(id = "delete-side", parent = "parent", account = "account") {
  return {
    conversationId: id, sourceConversationId: parent, hostId: "local",
    accountId: account, userId: "user", title: id, collaborationMode: null,
  };
}

/** A controllable async boundary exposes mutation, RPC and restart races deterministically. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

/**
 * Exercise production main.handle and mutationStorage together. Each renderer has an independent
 * published snapshot, all commits share native main state, and flush writes an actual external file.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-side-delete-state-"));
  const file = path.join(root, "state.json");
  let value = {};
  let beforeFlush;
  let failure;
  const windows = [];
  const store = {
    get: () => value,
    set: (_, updated) => { value = updated; },
    async flushOrThrow() {
      await beforeFlush?.();
      if (failure) throw failure;
      fs.writeFileSync(file, JSON.stringify(value));
    },
  };
  const context = {
    globalState: store,
    broadcastPersistedAtomUpdate(_, key, updated) {
      for (const window of windows) window.deliver(key, structuredClone(updated));
    },
    sendMessageToOrigin(window, message) { window.deliver(message.key, message.value); },
  };
  /** New windows consume a fresh native snapshot, including records surviving a disk restart. */
  const newWindow = () => {
    const cache = new Map(Object.entries(structuredClone(value)));
    const listeners = new Map();
    const window = {
      deliver(key, updated) {
        cache.set(key, updated);
        for (const callback of listeners.get(key) ?? []) callback(updated);
      },
    };
    const storage = runtime.mutationStorage({
      readValue: (key) => cache.get(key),
      publish: (key, updated) => state.handle(context, window, key, updated),
      subscribe(key, callback) {
        const set = listeners.get(key) ?? new Set();
        set.add(callback); listeners.set(key, set);
        return () => { set.delete(callback); if (!set.size) listeners.delete(key); };
      },
      clearReply: (key) => cache.delete(key), timeoutMs: 1000,
    });
    windows.push(window);
    return { window, storage, listeners, cache };
  };
  const first = newWindow();
  return {
    ...first, store, context, file, newWindow,
    setFailure(error) { failure = error; },
    setFlush(callback) { beforeFlush = callback; },
    restart() { value = JSON.parse(fs.readFileSync(file)); },
    dispose() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** All RPCs and live cleanup targets are captured; no real app or engine is contacted. */
function operation(storage, descriptor = durable(), send = async () => ({})) {
  const requests = [];
  const cleaned = [];
  return {
    storage, durable: descriptor,
    manager: { sendRequest: async (method, params) => {
      requests.push({ method, params }); return send(method, params);
    } },
    readIdentity: () => ({ accountId: "account", userId: "user" }),
    cleanup: async (target) => { cleaned.push(target.conversationId); },
    requests, cleaned,
  };
}

test("native RPC waits for a disk-confirmed claim; duplicate submits share the same operation", async () => {
  const f = fixture();
  try {
    await runtime.remember(f.storage, durable(), ["parent-turn"]);
    const disk = deferred();
    f.setFlush(() => disk.promise);
    const o = operation(f.storage);
    const first = runtime.permanentlyDelete(o);
    assert.strictEqual(runtime.permanentlyDelete(o), first);
    await Promise.resolve();
    assert.equal(o.requests.length, 0);
    assert.equal(runtime.readRegistry(f.storage).records["delete-side"].deletion, undefined);
    disk.resolve();
    await first;
    assert.deepEqual(o.requests, [{ method: "thread/delete", params: { threadId: "delete-side" } }]);
    assert.deepEqual(o.cleaned, ["delete-side"]);
    assert.equal(f.listeners.size, 0);
    assert.equal([...f.cache.keys()].some(key => key.startsWith(state.ACK_PREFIX)), false);
    assert.equal(JSON.parse(fs.readFileSync(f.file))[state.REGISTRY_KEY].records["delete-side"], undefined);
  } finally { f.dispose(); }
});

test("deletion keeps parent/sibling layouts and rejects old snapshots even after a disk restart", async () => {
  const f = fixture();
  try {
    await runtime.remember(f.storage, durable(), []);
    await runtime.remember(f.storage, durable("sibling"), []);
    const old = structuredClone(runtime.readRegistry(f.storage));
    const layout = {
      version: 1, routes: [
        { tabId: "sidechat:delete-side", params: durable() },
        { tabId: "sidechat:sibling", params: durable("sibling") },
      ], topology: {
        right: { tabIds: ["sidechat:delete-side"], activeTabId: "sidechat:delete-side", open: true },
        bottom: { tabIds: ["sidechat:sibling"], activeTabId: "sidechat:sibling", open: true },
        focusArea: "right-panel", rightPanelFullWidth: true,
      },
    };
    f.store.set("", {
      ...f.store.get(),
      ["thread-tab-routes-v1:parent"]: layout, unrelated: { untouched: true },
    });
    await runtime.permanentlyDelete(operation(f.storage));
    const saved = f.store.get()["thread-tab-routes-v1:parent"];
    assert.deepEqual(saved.routes.map(r => r.tabId), ["sidechat:sibling"]);
    assert.equal(saved.topology.focusArea, "bottom-panel");
    assert.equal(saved.topology.right.open, false);
    assert.equal(saved.topology.rightPanelFullWidth, false);
    assert.deepEqual(f.store.get().unrelated, { untouched: true });
    f.restart();
    const second = f.newWindow();
    state.handle(f.context, second.window, state.REGISTRY_KEY, old);
    assert.equal(runtime.readRegistry(second.storage).records["delete-side"], undefined);
    assert.equal(runtime.readRegistry(second.storage).records.sibling.durable.conversationId, "sibling");
    await assert.rejects(runtime.remember(second.storage, durable(), []), /deleted/);
    const staleLayout = state.handle(f.context, second.window, "thread-tab-routes-v1:parent", layout);
    assert.deepEqual(staleLayout.value.routes.map(r => r.tabId), ["sidechat:sibling"]);
  } finally { f.dispose(); }
});

test("definitive RPC failure clears only its requested claim and allows a later retry", async () => {
  const f = fixture();
  try {
    await runtime.remember(f.storage, durable(), []);
    const o = operation(f.storage, durable(), async () => {
      throw Object.assign(Error("permission denied"), { jsonRpcCode: -32001 });
    });
    await assert.rejects(runtime.permanentlyDelete(o), /permission denied/);
    assert.equal(runtime.readRegistry(f.storage).records["delete-side"].deletion, undefined);
    assert.deepEqual(o.cleaned, []);
    await runtime.permanentlyDelete(operation(f.storage));
  } finally { f.dispose(); }
});

test("transport ambiguity survives restart; only the exact target's missing-rollout error completes it", async () => {
  const f = fixture();
  try {
    await runtime.remember(f.storage, durable(), []);
    const o = operation(f.storage, durable(), async () => { throw Error("connection lost"); });
    await assert.rejects(runtime.permanentlyDelete(o), /connection lost/);
    assert.equal(runtime.readRegistry(f.storage).records["delete-side"].deletion.phase, "requested");
    f.restart();
    const second = f.newWindow();
    const retry = operation(second.storage, durable(), async () => {
      throw Object.assign(Error("no rollout found for thread id delete-side"), { jsonRpcCode: -32600 });
    });
    await runtime.permanentlyDelete(retry);
    assert.equal(runtime.readRegistry(second.storage).records["delete-side"], undefined);
    assert.equal(runtime.missingDeletedThread(
      { jsonRpcCode: -32600, message: "no rollout found for thread id sibling" }, "delete-side"), false);
    assert.equal(runtime.missingDeletedThread({ jsonRpcCode: -32600, message: "invalid request" }, "delete-side"), false);
  } finally { f.dispose(); }
});

test("a failed claim flush cannot delete; native success plus cleanup failure retries without another RPC", async () => {
  const f = fixture();
  try {
    await runtime.remember(f.storage, durable(), []);
    f.setFailure(Error("disk failure"));
    const o = operation(f.storage);
    await assert.rejects(runtime.permanentlyDelete(o), /disk failure/);
    assert.equal(o.requests.length, 0);
    f.setFailure(null);
    const retry = operation(f.storage);
    retry.cleanup = async () => { throw Error("layout failure"); };
    await assert.rejects(runtime.permanentlyDelete(retry), /layout failure/);
    assert.equal(runtime.readRegistry(f.storage).records["delete-side"].deletion.phase, "native-deleted");
    f.restart();
    const resumed = operation(f.newWindow().storage);
    await runtime.permanentlyDelete(resumed);
    assert.equal(resumed.requests.length, 0);
    assert.deepEqual(resumed.cleaned, ["delete-side"]);
  } finally { f.dispose(); }
});

test("failed final or cancellation flush retains a retryable deletion marker in memory", async () => {
  for (const failingAction of ["finish", "cancel"]) {
    const f = fixture();
    try {
      await runtime.remember(f.storage, durable(), []);
      f.setFlush(async () => {
        if (f.store.get()[state.REGISTRY_KEY].records["delete-side"]?.deletion == null) {
          throw Error("flush could not clear deletion intent");
        }
      });
      const o = operation(f.storage, durable(), async () => {
        if (failingAction === "cancel") {
          throw Object.assign(Error("native rejection"), { jsonRpcCode: -32600 });
        }
        return {};
      });
      await assert.rejects(runtime.permanentlyDelete(o), /could not clear/);
      const record = runtime.readRegistry(f.storage).records["delete-side"];
      assert.equal(record.deletion.phase, failingAction === "finish" ? "native-deleted" : "requested");
      f.setFlush(null);
      const retry = operation(f.storage);
      await runtime.permanentlyDelete(retry);
      assert.equal(retry.requests.length, failingAction === "finish" ? 0 : 1);
    } finally { f.dispose(); }
  }
});

test("cross-window title writes merge, cannot erase pending deletion, and late restores fail", async () => {
  const f = fixture();
  try {
    await runtime.remember(f.storage, durable(), []);
    await runtime.remember(f.storage, durable("sibling"), []);
    const second = f.newWindow();
    const pending = deferred();
    const o = operation(f.storage, durable(), () => pending.promise);
    const deleting = runtime.permanentlyDelete(o);
    while (o.requests.length === 0) await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => runtime.assertUsable(second.storage, durable(), "account", "user"), /deleted/);
    assert.throws(() => runtime.remember(second.storage, { ...durable(), title: "stale" }), /deleted/);
    assert.throws(() => runtime.guardSideRequest(second.storage, "local", "turn/start", {
      threadId: "delete-side",
    }), /deleted/);
    await runtime.nameFirstTurn(second.storage, durable("sibling"), "updated sibling");
    pending.resolve({});
    await deleting;
    assert.equal(runtime.readRegistry(second.storage).records.sibling.durable.title, "updated sibling");
    assert.throws(() => runtime.assertUsable(second.storage, durable(), "account", "user"), /deleted/);
    assert.throws(() => runtime.remember(second.storage, durable()), /deleted/);
    await assert.rejects(runtime.permanentlyDelete(operation(second.storage, durable("parent", "parent"))), /available/);
    await assert.rejects(runtime.permanentlyDelete(operation(second.storage, durable("sibling", "parent", "other"))), /identity/);
  } finally { f.dispose(); }
});

test("native deletion events and KV completion close other windows; manager disposal removes listeners", async () => {
  const f = fixture();
  try {
    await runtime.remember(f.storage, durable(), []);
    const second = f.newWindow();
    const cleaned = [];
    let onDeleted;
    let removed = 0;
    const manager = {
      cleanup: [], disposed: false,
      addThreadDeletedListener(callback) { onDeleted = callback; return () => { removed++; }; },
      sendRequest: async () => { throw Error("an event-confirmed delete must not send another RPC"); },
    };
    const binding = runtime.bindDeletionManager(manager, {
      storage: second.storage,
      readIdentity: () => ({ accountId: "account", userId: "user" }),
      subscribe: (callback) => {
        // Subscribe through the actual fixture's native transport.
        const original = second.window.deliver;
        second.window.deliver = (key, value) => { original(key, value); if (key === state.REGISTRY_KEY) callback(); };
        return () => { second.window.deliver = original; };
      },
    });
    const unregister = binding.register(async d => { cleaned.push(d.conversationId); });
    onDeleted("delete-side");
    while (runtime.readRegistry(second.storage).records["delete-side"] != null) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(cleaned.includes("delete-side"));
    assert.strictEqual(runtime.bindDeletionManager(manager, {}), binding);
    unregister();
    manager.cleanup[0]();
    assert.equal(removed, 1);
  } finally { f.dispose(); }
});

/**
 * Drive the production native-menu handlers with synthetic rows: selecting opens confirmation
 * without deleting or opening the chat, while dismissal preserves native focus restoration.
 */
test("native menu hands focus to confirmation only on selection and never sends a deletion request", () => {
  const selected = [];
  const refs = [];
  let cursor = 0;
  let initializations = 0;
  const context = {
    Q: { jsx: (type, props) => ({ type, props }) },
    __sideReactFactory: () => ({
      useRef(initial) { const i = cursor++; return refs[i] ??= { current: initial }; },
    }),
    __sideInitMenu() { initializations++; },
    __sideMenu: "native-menu", __sideMenuItem: "native-menu-item",
    __sideDelete() { throw Error("menu selection must not delete"); },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL("../hooks/side-list.js", import.meta.url), "utf8"), context);
  const row = { title: "synthetic", durable: durable() };
  const render = (item = row) => {
    cursor = 0;
    return context.__codexSideChatMenu({ row: item, onDelete: item => selected.push(item) });
  };
  const menu = render();
  let prevented = 0;
  const event = { preventDefault() { prevented++; } };
  menu.props.onCloseAutoFocus(event);
  assert.equal(prevented, 0, "escape/outside dismissal keeps the native trigger focus restore");
  assert.equal(selected.length, 0);
  menu.props.children.props.onSelect();
  assert.strictEqual(selected[0], row);
  menu.props.onCloseAutoFocus(event);
  assert.equal(prevented, 1, "menu close cannot take focus from the confirmation's cancel button");
  menu.props.onCloseAutoFocus(event);
  assert.equal(prevented, 1, "the focus handoff flag clears after the close event");
  const retry = render({ ...row, deletion: { phase: "native-deleted" } });
  assert.equal(retry.props.children.props.children, "重试永久删除");
  retry.props.children.props.onSelect();
  assert.equal(selected.length, 2);
  assert.equal(initializations, 2);
});

/**
 * Evaluate the actual dialog template with native-shaped components and a small hook renderer.
 * This verifies cancellation and same-frame submission behavior instead of matching source text.
 */
test("actual confirmation defaults to cancel, cancellation sends nothing, double submit stays busy on failure", async () => {
  const values = [];
  let cursor = 0;
  const request = deferred();
  let calls = 0;
  let closed = 0;
  const context = {
    Q: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    __sideReactFactory: () => ({
      useState(initial) {
        const i = cursor++;
        if (!(i in values)) values[i] = initial;
        return [values[i], updated => { values[i] = updated; }];
      },
      useRef(initial) { const i = cursor++; return values[i] ??= { current: initial }; },
    }),
    __sideDelete: () => { calls++; return request.promise; },
    __sideInitButton() {}, __sideInitDialog() {}, __sideInitLayout() {},
    __sideInitSlot() {}, __sideInitText() {}, __sideInitContainer() {},
    __sideDialog: "dialog", __sideDialogForm: "form", __sideDialogSection: "section",
    __sideDialogHeader: "header", __sideDialogTitle: "title", __sideDialogDescription: "description",
    __sideDialogActions: "actions", __sideButton: "button",
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL("../hooks/side-list.js", import.meta.url), "utf8"), context);
  const props = { scope: {}, row: { title: "synthetic", durable: durable() }, onClose: () => { closed++; } };
  const render = () => { cursor = 0; return context.__codexSideDeleteDialog(props); };
  let dialog = render();
  let buttons = dialog.props.children.props.children[2].props.children.props.children;
  assert.equal(buttons[0].props.autoFocus, true);
  buttons[0].props.onClick();
  assert.equal(calls, 0);
  assert.equal(closed, 1);
  const submit = dialog.props.children.props.onSubmit;
  const first = submit({ preventDefault() {} });
  await submit({ preventDefault() {} });
  assert.equal(calls, 1);
  dialog = render();
  buttons = dialog.props.children.props.children[2].props.children.props.children;
  assert.equal(buttons[1].props.loading, true);
  request.reject(Error("synthetic RPC failure"));
  await first;
  dialog = render();
  assert.equal(dialog.props.children.props.children[1].props.role, "alert");
  assert.equal(closed, 1, "failed deletion keeps the confirmation open");
});

test("actual native cleanup bypasses close callbacks and undo while preserving parent and sibling tabs", () => {
  const targets = ["right", "bottom"];
  const controllers = new Map(targets.map(target => [target, {
    tabs$: target + "-tabs", tabById$: target + "-by-id",
  }]));
  const rows = new Map([
    ["right", [
      { tabId: "sidechat:delete-side", onClose: () => { throw Error("voice rollback must be bypassed"); },
        onBeforeClose: () => false },
      { tabId: "sidechat:sibling" },
    ]],
    ["bottom", [{ tabId: "parent" }]],
  ]);
  const closed = [];
  const layoutIds = [];
  /** Native relation storage is a signal family; the initialization function is not a signal. */
  const relationFamily = { id: "native-relation-family" };
  let relations = ["delete-side", "sibling"];
  const scope = {
    value: { conversationId: "parent" },
    get(key, id) {
      const target = targets.find(target => key.startsWith(target));
      return key.endsWith("tabs") ? rows.get(target) : rows.get(target)?.find(tab => tab.tabId === id);
    },
    set(key, parent, update) {
      assert.strictEqual(key, relationFamily); assert.equal(parent, "parent");
      relations = update(relations);
    },
  };
  for (const [target, controller] of controllers) {
    controller.updateTab = (_, id, update) => Object.assign(rows.get(target).find(tab => tab.tabId === id), update);
    controller.closeTab = (_, id, options) => {
      const tab = rows.get(target).find(tab => tab.tabId === id);
      assert.equal(tab.onClose, undefined); assert.equal(tab.onBeforeClose, undefined);
      assert.equal(options.recordCloseUndo, false);
      rows.set(target, rows.get(target).filter(tab => tab.tabId !== id)); closed.push(id);
    };
  }
  const context = {
    dG: target => controllers.get(target),
    FD: () => { throw Error("signal initialization cannot be used as relation storage"); },
    /** Match the native relation-removal helper's scope/parent/child argument contract. */
    JEn: (targetScope, parent, child) =>
      targetScope.set(relationFamily, parent, values => values.filter(id => id !== child)),
    OOi: (_, parent, ids) => { assert.equal(parent, "parent"); layoutIds.push(...ids); },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL("../hooks/delete-adapter.js", import.meta.url), "utf8")
    .replaceAll("export function", "function"), context);
  context.__codexSideCleanTabs(scope, durable());
  assert.deepEqual(closed, ["sidechat:delete-side"]);
  assert.deepEqual(rows.get("right").map(tab => tab.tabId), ["sidechat:sibling"]);
  assert.deepEqual(rows.get("bottom").map(tab => tab.tabId), ["parent"]);
  assert.deepEqual(relations, ["sibling"]);
  assert.ok(layoutIds.includes("sidechat:delete-side"));
  context.__codexSideCleanTabs(scope, durable());
  assert.deepEqual(closed, ["sidechat:delete-side"], "cleanup is idempotent");
  context.__codexSideCleanTabs(scope, durable("sibling", "other-parent"));
  assert.deepEqual(relations, ["sibling"], "a different parent scope cannot remove its relation");
});

test("atomic names include hidden and legacy siblings, isolate identities, and survive restart", async () => {
  const f = fixture();
  try {
    const second = f.newWindow();
    const placeholder = { phase: "placeholder", baseTitle: "侧边聊天" };
    const [a, b] = await Promise.all([
      runtime.remember(f.storage, durable("a"), ["inherited"], placeholder),
      runtime.remember(second.storage, durable("b"), ["inherited"], placeholder),
    ]);
    assert.deepEqual([a.title, b.title], ["侧边聊天", "侧边聊天 2"]);
    await runtime.hide(f.storage, "a");
    const c = await runtime.remember(second.storage, durable("c"), [], placeholder);
    assert.equal(c.title, "侧边聊天 3", "hidden records reserve their visible name");
    await runtime.remember(f.storage, { ...durable("legacy"), title: "分析请求" }, []);
    const content = { phase: "content", baseTitle: "分析请求" };
    const d = await runtime.remember(f.storage, durable("d"), [], content);
    assert.equal(d.title, "分析请求 (2)", "preexisting legacy titles participate without migration");
    for (const [id, parent, account] of [
      ["other-parent", "different", "account"], ["other-account", "parent", "different"],
    ]) {
      const isolated = await runtime.remember(f.storage, durable(id, parent, account), [], placeholder);
      assert.equal(isolated.title, "侧边聊天");
    }
    const otherUser = await runtime.remember(f.storage,
      { ...durable("other-user"), userId: "different" }, [], placeholder);
    assert.equal(otherUser.title, "侧边聊天");
    f.restart();
    const reopened = await runtime.remember(f.newWindow().storage, { ...a, title: "old snapshot" });
    assert.equal(reopened.title, "侧边聊天");
    assert.equal(runtime.readRegistry(f.storage).records.a.naming.phase, "placeholder");
    assert.equal(f.listeners.size, 0, "mutation receipts leave no background subscriptions");
  } finally { f.dispose(); }
});

test("only first own successful turn names; collisions, live rows and saved layouts share one title", async () => {
  const f = fixture();
  try {
    const second = f.newWindow();
    const naming = { phase: "placeholder", baseTitle: "Side chat" };
    const a = await runtime.remember(f.storage, durable("a"), ["parent-turn"], naming);
    const b = await runtime.remember(second.storage, durable("b"), ["parent-turn"], naming);
    const inherited = [{ turnId: "parent-turn" }];
    assert.equal(runtime.shouldNameFirstTurn(f.storage, "a", inherited), true);
    assert.equal(runtime.shouldNameFirstTurn(f.storage, "a",
      [...inherited, { turnId: "side-turn" }]), false);
    assert.equal(runtime.shouldNameFirstTurn(f.storage, "a", null), false);
    const key = "thread-tab-routes-v1:parent";
    const oldLayout = {
      version: 1, routes: [
        { tabId: "sidechat:a", params: a }, { tabId: "sidechat:b", params: b },
        { tabId: "unrelated", params: { ...a, accountId: "different", title: "private" } },
      ], topology: {
        right: { tabIds: ["sidechat:a"], activeTabId: "sidechat:a", open: true },
        bottom: { tabIds: ["sidechat:b"], activeTabId: "sidechat:b", open: true },
        focusArea: "right-panel", rightPanelFullWidth: false,
      },
    };
    f.store.set("", { ...f.store.get(), [key]: oldLayout });
    const [namedA, namedB] = await Promise.all([
      runtime.nameFirstTurn(f.storage, a, "分析请求"),
      runtime.nameFirstTurn(second.storage, b, "分析请求"),
    ]);
    assert.deepEqual([namedA.title, namedB.title], ["分析请求", "分析请求 (2)"]);
    assert.equal(runtime.shouldNameFirstTurn(f.storage, "a", inherited), false);
    const unchanged = await runtime.nameFirstTurn(second.storage, a, "later followup");
    assert.equal(unchanged.title, namedA.title);
    const restored = await runtime.remember(second.storage, a);
    assert.equal(restored.title, namedA.title, "old restore cannot overwrite first-turn naming");
    const rows = runtime.summaryRows(runtime.readRegistry(f.storage),
      [{ conversationId: "a", title: "old open tab" }],
      { accountId: "account", userId: "user", sourceConversationId: "parent" });
    assert.deepEqual(rows.map(row => row.title), ["分析请求", "分析请求 (2)"]);
    const saved = JSON.parse(fs.readFileSync(f.file))[key];
    assert.deepEqual(saved.routes.map(route => route.params.title), ["分析请求", "分析请求 (2)", "private"]);
    assert.deepEqual(saved.topology, oldLayout.topology);
    assert.deepEqual(state.handle(f.context, f.window, key, oldLayout).value.routes,
      saved.routes, "late layout publishes rebase titles against the authoritative registry");
    f.restart();
    const restarted = f.newWindow();
    assert.equal(runtime.readRegistry(restarted.storage).records.a.naming.phase, "content");
    assert.equal(runtime.shouldNameFirstTurn(restarted.storage, "a", inherited), false);
  } finally { f.dispose(); }
});

test("duplicate first callbacks serialize, textless success seals naming, and deletion blocks late names", async () => {
  const f = fixture();
  try {
    const second = f.newWindow();
    const naming = { phase: "placeholder", baseTitle: "Side chat" };
    const a = await runtime.remember(f.storage, durable("a"), [], naming);
    const results = await Promise.all([
      runtime.nameFirstTurn(f.storage, a, "first accepted"),
      runtime.nameFirstTurn(second.storage, a, "duplicate success"),
    ]);
    assert.deepEqual(results.map(result => result.title), ["first accepted", "first accepted"]);
    const b = await runtime.remember(f.storage, durable("b"), [], naming);
    const textless = await runtime.nameFirstTurn(f.storage, b, null);
    assert.equal(textless.title, b.title);
    assert.equal(runtime.shouldNameFirstTurn(f.storage, "b", []), false);
    assert.equal((await runtime.nameFirstTurn(f.storage, b, "second turn")).title, b.title);
    const c = await runtime.remember(f.storage, durable("c"), [], naming);
    await f.storage.commit({ action: "request-delete", durable: c, operationId: "delete" });
    assert.throws(() => runtime.nameFirstTurn(second.storage, c, "late response"), /deleted/);
    assert.equal(runtime.shouldNameFirstTurn(second.storage, "c", []), false);
    await assert.rejects(second.storage.commit({
      action: "name-first-turn", durable: { ...a, accountId: "different" }, title: "foreign",
    }), /ownership changed/);
    assert.equal(runtime.readRegistry(f.storage).records.a.durable.title, "first accepted");
  } finally { f.dispose(); }
});

test("failed title flush keeps its previous name and phase, allowing the same success to retry", async () => {
  const f = fixture();
  try {
    const a = await runtime.remember(f.storage, durable("a"), [], {
      phase: "placeholder", baseTitle: "Side chat",
    });
    f.setFailure(Error("disk unavailable"));
    await assert.rejects(runtime.nameFirstTurn(f.storage, a, "new title"), /disk unavailable/);
    assert.equal(runtime.readRegistry(f.storage).records.a.durable.title, "Side chat");
    assert.equal(runtime.readRegistry(f.storage).records.a.naming.phase, "placeholder");
    assert.equal(JSON.parse(fs.readFileSync(f.file))[state.REGISTRY_KEY].records.a.durable.title,
      "Side chat");
    f.setFailure(null);
    assert.equal((await runtime.nameFirstTurn(f.storage, a, "new title")).title, "new title");
  } finally { f.dispose(); }
});

test("a panel move during title flush keeps the latest topology in disk and renderer broadcasts", async () => {
  const f = fixture();
  try {
    const a = await runtime.remember(f.storage, durable("a"), [], {
      phase: "placeholder", baseTitle: "Side chat",
    });
    const key = "thread-tab-routes-v1:parent";
    const empty = { tabIds: [], activeTabId: null, open: false };
    const occupied = { tabIds: ["sidechat:a"], activeTabId: "sidechat:a", open: true };
    const old = {
      version: 1, routes: [{ tabId: "sidechat:a", params: a }],
      topology: { right: occupied, bottom: empty, focusArea: "right-panel", rightPanelFullWidth: false },
    };
    f.store.set("", { ...f.store.get(), [key]: old });
    const disk = deferred();
    const entered = deferred();
    f.setFlush(() => { entered.resolve(); return disk.promise; });
    const naming = runtime.nameFirstTurn(f.storage, a, "new title");
    await entered.promise;
    const moved = { ...old, topology: {
      right: empty, bottom: occupied, focusArea: "bottom-panel", rightPanelFullWidth: false,
    } };
    const accepted = state.handle(f.context, f.window, key, moved).value;
    f.store.set("", { ...f.store.get(), [key]: accepted });
    disk.resolve();
    await naming;
    assert.deepEqual(f.cache.get(key).topology, moved.topology);
    assert.equal(f.cache.get(key).routes[0].params.title, "new title");
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file))[key], f.cache.get(key));
  } finally { f.dispose(); }
});

test("native title hook maps entity keys to turn IDs and follows right/bottom tabs until disposal", async () => {
  const f = fixture();
  try {
    const a = await runtime.remember(f.storage, durable("a"), ["parent-turn"], {
      phase: "placeholder", baseTitle: "Side chat",
    });
    const controllers = new Map(["right", "bottom"].map(target => [target, {
      tabById$: target, updateTab: (_, id, update) => {
        assert.equal(id, "sidechat:a"); Object.assign(tabs.get(target), update); updates++;
      },
    }]));
    const initial = () => ({
      tabId: "sidechat:a", title: a.title,
      durableRoute: { kind: "side-conversation", params: a, payloadVersion: 1 },
      props: { content: { hostId: "local", conversationId: "a", durable: {
        ...a, retrySetup: () => "original callback",
      } } },
    });
    const tabs = new Map([["right", initial()], ["bottom", null]]);
    const subscriptions = new Set();
    const released = [];
    let updates = 0;
    let canonicalReads = 0;
    let account = "account";
    const scope = {
      value: { conversationId: "parent" },
      get(key) {
        if (key === "account") return account;
        if (key === "user") return "user";
        if (key === "canonical") { canonicalReads++; return [{ entityKey: "native-entity" }]; }
        if (key === "turn-id") return "parent-turn";
        return tabs.get(key);
      },
    };
    const context = {
      __scp: runtime, codexSidePatchStorage: () => f.storage,
      q_: "account", Av: "user", Aw: "canonical", Nw: "turn-id", r2n: "native-count",
      dG: target => controllers.get(target),
      bv: (key, _, callback) => {
        assert.equal(key, runtime.REGISTRY_KEY);
        subscriptions.add(callback); return () => subscriptions.delete(callback);
      },
      __codexSideDeleteBinding: () => ({ binding: {
        register: () => () => released.push("delete registration"),
      } }),
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(new URL("../hooks/delete-adapter.js", import.meta.url), "utf8")
      .replaceAll("export function", "function"), context);
    // Override only the manager factory; the actual tab registration and title adapter run intact.
    context.__codexSideDeleteBinding = () => ({ binding: {
      register: () => () => released.push("delete registration"),
    } });
    vm.runInContext(fs.readFileSync(new URL("../hooks/title-adapter.js", import.meta.url), "utf8")
      .replaceAll("export function", "function").replaceAll("export async function", "async function"), context);
    assert.equal(context.codexSidePatchIsFirstTurn(scope, "a"), true,
      "native entity identity is not the inherited RPC turn ID");
    const release = context.codexSidePatchRegisterDeletionTab(scope, a);
    assert.equal(subscriptions.size, 1);
    await context.codexSidePatchNameFirstTurn(scope, "a", "first title");
    assert.equal(tabs.get("right").title, "first title");
    assert.equal(tabs.get("right").durableRoute.params.title, "first title");
    assert.equal(tabs.get("right").props.content.durable.title, "first title");
    assert.equal(tabs.get("right").props.content.durable.retrySetup(), "original callback");
    const before = canonicalReads;
    assert.equal(context.codexSidePatchIsFirstTurn(scope, "a"), false);
    assert.equal(canonicalReads, before, "completed naming avoids rescanning canonical turns");
    tabs.set("bottom", initial()); tabs.set("right", null);
    for (const callback of subscriptions) callback();
    assert.equal(tabs.get("bottom").title, "first title");
    assert.equal(updates, 2);
    account = "different"; tabs.get("bottom").title = "retired";
    for (const callback of subscriptions) callback();
    assert.equal(tabs.get("bottom").title, "retired", "retired account scopes do not expose names");
    assert.throws(() => context.codexSidePatchIsFirstTurn(scope, "a"), /identity changed/);
    release();
    assert.equal(subscriptions.size, 0);
    assert.equal(released.length, 1);
  } finally { f.dispose(); }
});

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
});

test("legacy and unified presentation hide inherited history while canonical context stays intact", () => {
  const storage = storageFixture();
  persistence.remember(storage, durable(), ["parent-old", "parent-new"]);
  const turns = [
    { turnId: "parent-old", items: [{ type: "userMessage", text: "parent" }] },
    { turnId: "side-first", items: [{ type: "agentMessage", text: "side" }] },
    { turnId: "parent-new", items: [{ type: "agentMessage", text: "parent" }] },
    { turnId: "side-pending", items: [{ type: "imageGeneration", src: "side-attachment" }] },
  ];
  const before = structuredClone(turns);
  assert.deepEqual(
    persistence.displayTurns(storage, { id: "side-one", hostId: "local" }, turns)
      .map((turn) => turn.turnId),
    ["side-first", "side-pending"],
  );
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
  assert.strictEqual(persistence.displayTurns(storage, { id: "parent-one", hostId: "local" }, turns), turns);
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

/**
 * Evaluate the actual version adapter's creation function with native API-shaped services.
 * The fixture records side-boundary policy, persistent fork flags and cancelled-thread cleanup.
 */
function creationFixture(hostId = "local") {
  const storage = storageFixture();
  const requests = [];
  let account = "account-one";
  let pending = true;
  const context = {
    __scp: persistence, __sideStorage: () => storage,
    __sideAccount: "account", __sideUser: "user",
    f: () => false, Ae: async () => ["/empty-workspace"],
    Le: async () => ({ instructions: "Native instructions" }),
    Ze: () => false, rt: "detail", bt: "Untrusted parent is reference only",
    ue: async (_, host, params) => {
      requests.push({ method: "fork", host, params });
      return { conversationId: "side-one", synchronization: { status: "complete" } };
    },
    H: () => ({
      sendRequest: async (method, params) => {
        requests.push({ method, params });
        return { data: [{ id: "parent-turn" }], nextCursor: null };
      },
      archiveConversation: async (id, options) => requests.push({ method: "archive", id, options }),
    }),
    Error, Promise,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL("../hooks/local-create.js", import.meta.url), "utf8"), context);
  return {
    invoke: () => context.zt({
      scope: { get: (atom) => atom === "account" ? account : atom === "user" ? "user-one" : false },
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

test("cancelled and identity-retired native creations are archived without recoverable orphan rows", async () => {
  for (const retire of ["cancel", "changeAccount"]) {
    const fixture = creationFixture();
    fixture.context.ue = async () => {
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

/**
 * Run the actual restoration adapter against account checks and native resume services.
 * Both asynchronous boundaries can retire the identity, without archiving an existing thread.
 */
function restorationFixture(changeAt) {
  let account = "account-one";
  const requests = [];
  const context = {
    __scp: persistence, r: () => false, f: () => true,
    U: (_, descriptor) => persistence.assertIdentity(descriptor, account, "user-one"),
    d: async () => {
      if (changeAt === "root-error") throw Error("Native workspace access failed");
      if (changeAt === "roots") account = "account-two";
      return ["/empty-workspace"];
    },
    S: (_, host) => ({
      resumeConversation: async (params, options) => {
        requests.push({ host, params, options });
        if (changeAt === "resume") account = "account-two";
        return { status: "ready" };
      },
    }),
    w: Error, i: (error) => error.message, Error,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL("../hooks/restore.js", import.meta.url), "utf8"), context);
  return {
    invoke: () => context.H({}, durable(), "parent-one", "/thread/parent-one"),
    requests,
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

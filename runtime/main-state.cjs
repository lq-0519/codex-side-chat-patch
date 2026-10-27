/** Main-process mutations reuse Codex's native global state and wait for its disk flush. */
"use strict";
/** Existing relation key remains backward compatible with records created before deletion. */
const REGISTRY_KEY = "codex-native-side-chats-v1";
/** Removed native UUIDs block stale renderer snapshots across application restarts. */
const TOMBSTONE_KEY = "codex-native-side-chat-deleted-ids-v1";
/** Replies use the existing persisted-atom transport without persisting per-request receipts. */
const ACK_PREFIX = "codex-native-side-chat-ack-v1:";
/** Native saved panel routes are the only other keys modified by deletion completion. */
const LAYOUT_PREFIX = "thread-tab-routes-v1:";
/** Serialize mutations per native store, including overlapping windows and disk flushes. */
const queues = new WeakMap();
/** Cache blocked UUID membership by immutable index/tombstone snapshots, never by chat bodies. */
const blockedSnapshots = new WeakMap();
/** Share an immutable empty tombstone snapshot until the first deletion has completed. */
const EMPTY_TOMBSTONES = Object.freeze({});

/** Verify the small ownership descriptor before accepting any destructive mutation. */
function validateDurable(durable) {
  if (durable?.hostId !== "local" ||
      !["conversationId", "sourceConversationId", "accountId", "userId"]
        .every((key) => typeof durable[key] === "string" && durable[key].length > 0) ||
      durable.conversationId === durable.sourceConversationId) {
    throw Error("Invalid saved side-chat ownership");
  }
}

/** Preserve account, user and parent boundaries even if a renderer submits stale metadata. */
function sameOwner(a, b) {
  return ["conversationId", "sourceConversationId", "hostId", "accountId", "userId"]
    .every((key) => a[key] === b[key]);
}

/** Apply the pinned native layout filter to matching routes, active tabs and focus only. */
function filterLayout(layout, conversationId) {
  if (layout?.version !== 1 || !Array.isArray(layout.routes) ||
      !layout.topology?.right || !layout.topology?.bottom) return layout;
  const ids = new Set([`sidechat:${conversationId}`]);
  for (const route of layout.routes) {
    if (route.params?.hostId === "local" &&
        route.params.conversationId === conversationId) ids.add(route.tabId);
  }
  /** Mirror native kOi, keeping an unaffected panel's object and active tab intact. */
  const panel = (value) => {
    const tabIds = value.tabIds.filter((id) => !ids.has(id));
    return tabIds.length === value.tabIds.length ? value : {
      ...value, tabIds, open: value.open && tabIds.length > 0,
      activeTabId: tabIds.includes(value.activeTabId) ? value.activeTabId : tabIds.at(-1) ?? null,
    };
  };
  const routes = layout.routes.filter((route) => !ids.has(route.tabId));
  const right = panel(layout.topology.right);
  const bottom = panel(layout.topology.bottom);
  if (routes.length === layout.routes.length &&
      right === layout.topology.right && bottom === layout.topology.bottom) return layout;
  let focusArea = layout.topology.focusArea;
  if (focusArea === "right-panel" && right.tabIds.length === 0) {
    focusArea = bottom.tabIds.length ? "bottom-panel" : "main";
  }
  if (focusArea === "bottom-panel" && bottom.tabIds.length === 0) {
    focusArea = right.tabIds.length ? "right-panel" : "main";
  }
  return {
    ...layout, routes, topology: {
      ...layout.topology, right, bottom, focusArea,
      rightPanelFullWidth: layout.topology.rightPanelFullWidth && right.tabIds.length > 0,
    },
  };
}

/**
 * Inspect only the layout's route/tab IDs on ordinary saves. Build blocked UUID membership once
 * per changed index snapshot, avoiding a scan of every saved/deleted side on each layout publish.
 */
function protectLayout(layout, state) {
  const index = state[REGISTRY_KEY];
  const tombstones = state[TOMBSTONE_KEY] ?? EMPTY_TOMBSTONES;
  if (index == null && tombstones === EMPTY_TOMBSTONES) return layout;
  const snapshot = index ?? tombstones;
  let pairs = blockedSnapshots.get(snapshot);
  if (pairs == null) blockedSnapshots.set(snapshot, pairs = new WeakMap());
  let blocked = pairs.get(tombstones);
  if (blocked == null) {
    blocked = new Set(Object.keys(tombstones));
    for (const [id, record] of Object.entries(index?.records ?? {})) {
      if (record.deletion?.phase === "native-deleted") blocked.add(id);
    }
    pairs.set(tombstones, blocked);
  }
  if (blocked.size === 0) return layout;
  const matching = new Set();
  for (const route of layout?.routes ?? []) {
    if (route.params?.hostId === "local" && blocked.has(route.params.conversationId)) {
      matching.add(route.params.conversationId);
    }
    if (route.tabId?.startsWith("sidechat:") && blocked.has(route.tabId.slice(9))) {
      matching.add(route.tabId.slice(9));
    }
  }
  for (const target of ["right", "bottom"]) {
    for (const tabId of layout?.topology?.[target]?.tabIds ?? []) {
      if (tabId.startsWith("sidechat:") && blocked.has(tabId.slice(9))) matching.add(tabId.slice(9));
    }
  }
  for (const id of matching) layout = filterLayout(layout, id);
  return layout;
}

/** Transform one current snapshot; whole-index writes from old renderers are never trusted. */
function mutate(state, mutation) {
  const index = state[REGISTRY_KEY] ?? { version: 1, records: {} };
  if (index.version !== 1 || !index.records || Array.isArray(index.records)) {
    throw Error("Unsupported saved side-chat index");
  }
  const durable = mutation.durable;
  validateDurable(durable);
  const id = durable.conversationId;
  const previous = index.records[id];
  const tombstones = state[TOMBSTONE_KEY] ?? {};
  if (previous != null && !sameOwner(previous.durable, durable)) {
    throw Error("Saved side-chat ownership changed");
  }
  const records = { ...index.records };
  const next = { ...state };
  const changed = new Set([REGISTRY_KEY]);
  const op = mutation.operationId;
  if (typeof op !== "string" || op.length === 0) throw Error("Missing mutation operation ID");
  switch (mutation.action) {
    case "remember":
      if (Object.hasOwn(tombstones, id) || previous?.deletion ||
          (previous == null && mutation.create !== true)) {
        throw Error("The side chat was deleted or is being deleted");
      }
      if (mutation.create === true && !Array.isArray(mutation.inheritedTurnIds)) {
        throw Error("A new saved side chat needs its inherited boundary");
      }
      records[id] = {
        durable: { ...durable, collaborationMode: durable.collaborationMode ?? null },
        inheritedTurnIds: previous?.inheritedTurnIds ?? mutation.inheritedTurnIds,
        hidden: false, createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(),
      };
      break;
    case "hide":
      if (previous == null || previous.deletion) break;
      records[id] = { ...previous, hidden: true, updatedAt: Date.now() };
      break;
    case "cancel-creation":
      if (previous?.deletion) throw Error("A confirmed deletion is still pending");
      delete records[id];
      next[TOMBSTONE_KEY] = { ...tombstones, [id]: true };
      changed.add(TOMBSTONE_KEY);
      break;
    case "request-delete":
    case "native-deleted":
      if (previous == null) {
        if (Object.hasOwn(tombstones, id)) break;
        throw Error("The saved side chat no longer exists");
      }
      if (previous.deletion && previous.deletion.operationId !== op) {
        throw Error("This side chat already has a deletion in progress");
      }
      records[id] = {
        ...previous, updatedAt: Date.now(),
        /** One operation owns the deletion; phase cannot regress after native success. */
        deletion: {
          operationId: op,
          phase: mutation.action === "native-deleted" ||
            previous.deletion?.phase === "native-deleted" ? "native-deleted" : "requested",
        },
      };
      break;
    case "cancel-delete":
      if (previous?.deletion?.operationId !== op ||
          previous.deletion.phase !== "requested") break;
      records[id] = { ...previous, updatedAt: Date.now() };
      delete records[id].deletion;
      break;
    case "finish-delete":
      if (previous != null &&
          (previous.deletion?.operationId !== op || previous.deletion.phase !== "native-deleted")) {
        throw Error("Native deletion has not been confirmed");
      }
      if (previous == null && !Object.hasOwn(tombstones, id)) {
        throw Error("Missing deletion record");
      }
      for (const [key, value] of Object.entries(state)) {
        if (!key.startsWith(LAYOUT_PREFIX)) continue;
        const filtered = filterLayout(value, id);
        if (filtered !== value) { next[key] = filtered; changed.add(key); }
      }
      delete records[id];
      next[TOMBSTONE_KEY] = { ...tombstones, [id]: true };
      changed.add(TOMBSTONE_KEY);
      break;
    default:
      throw Error("Unknown side-chat mutation");
  }
  next[REGISTRY_KEY] = { version: 1, records };
  return { state: next, changed };
}

/**
 * Handle only the patch's registry channel. Commit success is acknowledged after flushOrThrow;
 * a failed flush keeps the conservative in-memory deletion marker for a safe later retry.
 * Late layout snapshots are also filtered against pending deletions and durable tombstones.
 */
function handle(context, sender, key, value) {
  const store = context.globalState;
  if (key.startsWith(LAYOUT_PREFIX)) {
    const state = store.get("electron-persisted-atom-state") ?? {};
    return { handled: false, value: protectLayout(value, state) };
  }
  if (key !== REGISTRY_KEY) return { handled: false, value };
  if (value?.kind !== "codex-side-mutation-v1") {
    context.broadcastPersistedAtomUpdate(sender, key,
      store.get("electron-persisted-atom-state")?.[key]);
    return { handled: true };
  }
  const mutation = value.mutation;
  const replyId = value.requestId;
  /** Queue rejection is consumed so an unsuccessful operation cannot block later mutations. */
  const job = (queues.get(store) ?? Promise.resolve()).then(async () => {
    let ack;
    let previousRecord;
    let applied = false;
    try {
      const current = store.get("electron-persisted-atom-state") ?? {};
      previousRecord = current[REGISTRY_KEY]?.records[mutation?.durable?.conversationId];
      const result = mutate(current, mutation);
      store.set("electron-persisted-atom-state", result.state);
      applied = true;
      await store.flushOrThrow();
      for (const changedKey of result.changed) {
        context.broadcastPersistedAtomUpdate(sender, changedKey, result.state[changedKey]);
      }
      ack = { requestId: replyId, operationId: mutation.operationId, ok: true };
    } catch (error) {
      // Clearing intent or removing a completed record requires a confirmed flush. If it fails,
      // restore only that conservative marker, retaining unrelated KV/layout writes made meanwhile.
      if (applied && previousRecord?.deletion &&
          ["cancel-delete", "finish-delete"].includes(mutation.action)) {
        const current = store.get("electron-persisted-atom-state") ?? {};
        store.set("electron-persisted-atom-state", {
          ...current, [REGISTRY_KEY]: {
            version: 1, records: {
              ...current[REGISTRY_KEY].records,
              [mutation.durable.conversationId]: previousRecord,
            },
          },
        });
      }
      context.broadcastPersistedAtomUpdate(sender, REGISTRY_KEY,
        store.get("electron-persisted-atom-state")?.[REGISTRY_KEY]);
      ack = { requestId: replyId, operationId: mutation?.operationId, ok: false,
        error: { message: String(error?.message ?? error) } };
    }
    context.sendMessageToOrigin(sender, {
      type: "persisted-atom-updated", key: ACK_PREFIX + replyId, value: ack, deleted: false,
    });
  });
  queues.set(store, job.catch(() => {}));
  return { handled: true };
}

module.exports = { handle, mutate, filterLayout, REGISTRY_KEY, TOMBSTONE_KEY, ACK_PREFIX };

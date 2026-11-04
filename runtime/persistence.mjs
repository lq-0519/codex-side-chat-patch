/**
 * Versioned renderer helpers for native local side chats.
 * The supplied storage is Codex's existing persistent KV, never a second transcript store.
 */
export const REGISTRY_KEY = "codex-native-side-chats-v1";
/** Durable native-main tombstones block stale layout descriptors after registry removal. */
export const DELETED_KEY = "codex-native-side-chat-deleted-ids-v1";
/** Reuse the empty native index snapshot across ordinary local-chat reads. */
const EMPTY_REGISTRY = Object.freeze({ version: 1, records: Object.freeze({}) });

/**
 * Native KV publishes replacement object snapshots rather than mutating existing values.
 * Cache validation by snapshot identity, so repeated recents/stream selectors do not traverse
 * every saved side chat and every inherited ID. Weak keys let retired snapshots be collected.
 */
const validatedRegistries = new WeakSet();
/**
 * Reuse membership sets for at most four recently displayed boundaries and 20,000 cached IDs
 * per renderer. Title/hide changes keep their immutable ID array. Large boundaries still work
 * in full, but their one-use sets are not retained; persisted chat count cannot grow this cache.
 */
const inheritedBoundaries = new Map();
/** Native IPC clones ID arrays; weak ownership lets deletion release all cached snapshots of a UUID. */
const inheritedOwners = new WeakMap();
/** Bound cache entry count independently of the number of durable side chats on disk. */
const MAX_CACHED_BOUNDARIES = 4;
/** Bound retained membership IDs without truncating any canonical or displayed history. */
const MAX_CACHED_BOUNDARY_IDS = 20000;
/** Track the total retained IDs so eviction never scans or copies a complete membership set. */
let cachedBoundaryIds = 0;
/**
 * Group metadata by account/user/parent lazily for the active snapshot. This avoids scanning
 * every unrelated side chat on each tab or response-status update; values reference original
 * descriptors and never duplicate bodies or inherited ID arrays.
 */
const parentGroups = new WeakMap();
/**
 * Cache one display-only projection per native sidebar task. Weak keys release retired tasks;
 * unchanged titles reuse the same task reference so native list equality avoids needless renders.
 */
const sidebarTitles = new WeakMap();

/**
 * Read the relation index without overwriting an unknown schema or damaged value.
 * Each record contains a native durable descriptor, inherited turn IDs (display only),
 * a hidden flag, and creation/update timestamps. No message text is copied here.
 * The caller must follow native KV's replacement-snapshot contract and never mutate a value.
 */
export function readRegistry(storage) {
  const value = storage.readValue(REGISTRY_KEY);
  if (value == null) return EMPTY_REGISTRY;
  if (typeof value === "object" && validatedRegistries.has(value)) return value;
  if (
    value.version !== 1 || !value.records || typeof value.records !== "object" ||
    Array.isArray(value.records)
  ) {
    throw new Error("The saved side-chat index has an unsupported format");
  }
  for (const [id, record] of Object.entries(value.records)) {
    if (
      record?.durable?.conversationId !== id ||
      record.durable.hostId !== "local" ||
      typeof record.durable.sourceConversationId !== "string" ||
      typeof record.durable.accountId !== "string" ||
      typeof record.durable.userId !== "string" ||
      !Array.isArray(record.inheritedTurnIds) ||
      !record.inheritedTurnIds.every((turnId) => typeof turnId === "string") ||
      typeof record.hidden !== "boolean" ||
      (record.naming != null && !["placeholder", "content"].includes(record.naming.phase)) ||
      (record.deletion != null &&
        (typeof record.deletion.operationId !== "string" ||
          !["requested", "native-deleted"].includes(record.deletion.phase)))
    ) {
      throw new Error("The saved side-chat index contains an invalid record");
    }
  }
  validatedRegistries.add(value);
  return value;
}

/** Reuse immutable membership sets within the bounded cache; overflow never truncates history. */
function inheritedSet(record) {
  const ids = record.inheritedTurnIds;
  let inherited = inheritedBoundaries.get(ids);
  if (inherited != null) {
    inheritedBoundaries.delete(ids);
    inheritedBoundaries.set(ids, inherited);
    return inherited;
  }
  inherited = new Set(ids);
  if (ids.length > MAX_CACHED_BOUNDARY_IDS) return inherited;
  while (
    inheritedBoundaries.size >= MAX_CACHED_BOUNDARIES ||
    cachedBoundaryIds + ids.length > MAX_CACHED_BOUNDARY_IDS
  ) {
    const oldest = inheritedBoundaries.keys().next().value;
    inheritedBoundaries.delete(oldest);
    cachedBoundaryIds -= oldest.length;
  }
  inheritedBoundaries.set(ids, inherited);
  inheritedOwners.set(ids, record.durable.conversationId);
  cachedBoundaryIds += ids.length;
  return inherited;
}

/**
 * Compare all fields of the small JSON descriptor at an explicit write boundary.
 * Missing and undefined-valued fields are equivalent under JSON serialization. This does not
 * scan the complete registry or perform persistent I/O, and still detects every title change.
 */
function sameDescriptor(previous, updated) {
  return [...new Set([...Object.keys(previous), ...Object.keys(updated)])]
    .every((key) => previous[key] === updated[key]);
}

/**
 * Persist a relation before exposing the thread in a panel.
 * Descriptor fields follow the original application's nullable collaborationMode schema.
 * Existing boundary IDs, authoritative title and naming phase survive stale reopen descriptors.
 * Creation may supply {phase, baseTitle}; main allocates the unique name and returns its descriptor.
 */
export function remember(storage, durable, inheritedTurnIds, naming) {
  const index = readRegistry(storage);
  const previous = index.records[durable.conversationId];
  if (previous?.deletion || (previous == null && inheritedTurnIds == null)) {
    throw new Error("The side chat was deleted or is being deleted");
  }
  const descriptor = {
    ...durable, collaborationMode: durable.collaborationMode ?? null,
    ...(previous == null ? {} : { title: previous.durable.title }),
  };
  const boundary = inheritedTurnIds ?? previous?.inheritedTurnIds ?? [];
  if (
    previous != null && !previous.hidden && sameDescriptor(previous.durable, descriptor) &&
    (boundary === previous.inheritedTurnIds ||
      (boundary.length === previous.inheritedTurnIds.length &&
        boundary.every((id, position) => id === previous.inheritedTurnIds[position])))
  ) {
    return previous.durable;
  }
  if (storage.commit) return storage.commit({
    action: "remember", durable: descriptor, create: inheritedTurnIds != null, inheritedTurnIds, naming,
  });
  if (naming != null) throw Error("Side-chat naming requires native main-process mutations");
  const record = {
    ...previous,
    durable: descriptor,
    inheritedTurnIds: boundary,
    hidden: false,
    createdAt: previous?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  storage.writeValue(REGISTRY_KEY, {
    version: 1,
    records: { ...index.records, [durable.conversationId]: record },
  });
  return record.durable;
}

/**
 * Test only this side's canonical turn IDs against the exact inherited boundary. Unknown history
 * cannot prove a first turn. A persisted content phase also blocks duplicate callbacks/restarts;
 * legacy saved records can still name their first own turn when loaded history proves it is empty.
 */
export function shouldNameFirstTurn(storage, conversationId, turns) {
  const record = readRegistry(storage).records[conversationId];
  if (record == null || record.deletion || record.naming?.phase === "content" ||
      turns == null) return false;
  const inherited = inheritedSet(record);
  return turns.every((turn) => inherited.has(turn.turnId));
}

/**
 * Save native OI's cleaned title once, after native send success. Main owns suffix allocation and
 * duplicate-callback admission. No message text/model call is needed beyond that display title.
 * Empty text seals the first-turn phase while preserving the unique placeholder.
 */
export function nameFirstTurn(storage, durable, title) {
  const record = readRegistry(storage).records[durable.conversationId];
  assertUsable(storage, durable, durable.accountId, durable.userId);
  if (record.naming?.phase === "content") return Promise.resolve(record.durable);
  return storage.commit({ action: "name-first-turn", durable, title });
}

/**
 * Persist an explicit user rename through the same native queue as first-turn naming. Main
 * validates ownership, reserves sibling names and seals naming so a late first send cannot undo it.
 */
export function renameSide(storage, durable, title) {
  if (durable?.hostId !== "local") throw Error("Missing local saved side chat");
  assertUsable(storage, durable, durable.accountId, durable.userId);
  return storage.commit({ action: "rename", durable, title });
}

/** Hide a closed panel without deleting its native rollout or its discovery relation. */
export function hide(storage, conversationId) {
  const index = readRegistry(storage);
  const record = index.records[conversationId];
  if (record == null || record.hidden || record.deletion) return;
  if (storage.commit) return storage.commit({ action: "hide", durable: record.durable });
  storage.writeValue(REGISTRY_KEY, {
    version: 1,
    records: {
      ...index.records,
      [conversationId]: { ...record, hidden: true, updatedAt: Date.now() },
    },
  });
}

/** Forget only a successfully archived, cancelled creation; normal close never calls this. */
export function forgetCancelled(storage, conversationId) {
  const index = readRegistry(storage);
  if (!(conversationId in index.records)) return;
  if (storage.commit) return storage.commit({
    action: "cancel-creation", durable: index.records[conversationId].durable,
  });
  const records = { ...index.records };
  delete records[conversationId];
  storage.writeValue(REGISTRY_KEY, { version: 1, records });
}

/** Classify saved local side threads before thread hydration to keep them out of main recents. */
export function isSavedSide(storage, hostId, conversationId) {
  if (hostId !== "local") return false;
  return Boolean(readRegistry(storage).records[conversationId]);
}

/**
 * Resolve a saved side's own full display title by native host/UUID and signed-in account/user.
 * Hidden and legacy records remain discoverable; deleting, remote and foreign records cannot
 * contribute a title. This read uses one record lookup and does not hydrate or rename a thread.
 */
export function savedSideTitle(index, { hostId, conversationId, accountId, userId }) {
  if (hostId !== "local" || !accountId || !userId) return null;
  const record = index?.records?.[conversationId];
  const durable = record?.durable;
  return record?.deletion || durable?.hostId !== hostId ||
    durable.accountId !== accountId || durable.userId !== userId ||
    typeof durable.title !== "string" || !durable.title.trim() ? null : durable.title;
}

/**
 * Project only the local summary title consumed by Codex's catalog/live sidebar builder.
 * All native IDs, pinning inputs, timestamps, status and body references remain unchanged.
 * Each native task retains at most one cached projection, replaced when its own title changes.
 */
export function sidebarTask(index, task, identity) {
  if (task?.kind !== "local" || task.summary == null) return task;
  const title = savedSideTitle(index, { ...task.summary, ...identity });
  if (title == null || title === task.summary.title) return task;
  const cached = sidebarTitles.get(task);
  if (cached?.title === title) return cached.task;
  const updated = { ...task, summary: { ...task.summary, title } };
  sidebarTitles.set(task, { title, task: updated });
  return updated;
}

/**
 * Recognize both current and historical plugin descriptors. Tombstones keep deleted old layouts
 * guarded after their registry row has been removed by the completed native deletion transaction.
 */
export function isManagedSide(storage, durable) {
  if (durable?.hostId !== "local" || typeof durable.conversationId !== "string") return false;
  return durable.patchVersion === 1 ||
    readRegistry(storage).records[durable.conversationId] != null ||
    storage.readValue(DELETED_KEY)?.[durable.conversationId] != null;
}

/**
 * Recheck a saved local descriptor before completing its pending panel, including after
 * caller-supplied preparation. The caller's existing cancellation path archives only
 * newly created threads; restoring an existing thread never deletes its stored history.
 */
export function assertIdentity(durable, accountId, userId) {
  if (durable?.hostId === "local" &&
      (durable.accountId !== accountId || durable.userId !== userId)) {
    throw new Error("The signed-in identity changed before the side chat could open");
  }
}

/** Refuse deleted or deleting restores at every asynchronous boundary and final tab acceptance. */
export function assertUsable(storage, durable, accountId, userId) {
  assertIdentity(durable, accountId, userId);
  if (durable?.hostId !== "local") return;
  const record = readRegistry(storage).records[durable.conversationId];
  if (record == null || record.deletion ||
      record.durable.sourceConversationId !== durable.sourceConversationId ||
      record.durable.accountId !== accountId || record.durable.userId !== userId) {
    throw new Error("The side chat was deleted or is being deleted");
  }
}

/**
 * Filter inherited turns only in the renderer's presentation selector.
 * The input and native history remain intact; no server context is rewritten or truncated.
 * Exact IDs work for incomplete pages, canonical history and later parent turns.
 */
export function displayTurns(storage, conversation, turns) {
  if (conversation.hostId !== "local") return turns;
  const record = readRegistry(storage).records[conversation.id ?? conversation.conversationId];
  if (record == null) return turns;
  const inherited = inheritedSet(record);
  if (!turns.some((turn) => inherited.has(turn.turnId))) return turns;
  return turns.filter((turn) => !inherited.has(turn.turnId));
}

/**
 * Adapt the unified timeline's presentation inputs without changing the canonical history.
 * Keep turn/entity/position arrays aligned, remove only loaded inherited content positions,
 * and retain native gap entries so pagination can still load missing side turns.
 */
export function presentationOptions(storage, conversation, options) {
  if (conversation.hostId !== "local") return options;
  const record = readRegistry(storage).records[conversation.id];
  if (record == null) return options;
  const inherited = inheritedSet(record);
  const keep = options.conversationTurns.map((turn) => !inherited.has(turn.turnId));
  const positions = new Set();
  const entities = new Set();
  keep.forEach((include, index) => {
    if (include) return;
    const entry = options.historyEntriesByTurnIndex?.[index];
    if (entry) {
      positions.add(entry.positionKey);
      entities.add(entry.entityKey);
    }
    const entity = options.turnEntityKeys?.[index];
    if (entity != null) entities.add(entity);
  });
  return {
    ...options,
    conversationTurns: options.conversationTurns.filter((_, index) => keep[index]),
    historyEntriesByTurnIndex: options.historyEntriesByTurnIndex?.filter((_, index) => keep[index]),
    turnEntityKeys: options.turnEntityKeys?.filter((_, index) => keep[index]),
    historyTimeline: options.historyTimeline?.filter(
      (entry) => entry.type !== "content" ||
        (!positions.has(entry.key) && !entities.has(entry.value)),
    ),
    inheritedHistoryPositionKeys: undefined,
    parentConversationTurns: [],
    subagentParentThreadId: null,
  };
}

/**
 * Merge the existing open-tab list with saved local relations for the current parent.
 * Account/user checks run before presenting titles; open tab rows retain their native behavior.
 * A hidden row carries its descriptor so the original panel can reopen the same thread ID.
 */
export function summaryRows(index, openRows, { accountId, userId, sourceConversationId }) {
  if (index == null) return openRows;
  let accounts = parentGroups.get(index);
  if (accounts == null) {
    accounts = new Map();
    for (const record of Object.values(index.records ?? {})) {
      const durable = record.durable;
      if (durable.hostId !== "local") continue;
      let users = accounts.get(durable.accountId);
      if (users == null) accounts.set(durable.accountId, users = new Map());
      let parents = users.get(durable.userId);
      if (parents == null) users.set(durable.userId, parents = new Map());
      let records = parents.get(durable.sourceConversationId);
      if (records == null) parents.set(durable.sourceConversationId, records = []);
      records.push(record);
    }
    parentGroups.set(index, accounts);
  }
  const saved = accounts.get(accountId)?.get(userId)?.get(sourceConversationId);
  if (saved == null) return openRows;
  const byId = new Map(saved.map((record) => [record.durable.conversationId, record]));
  let rows = openRows.map((row) => {
    const record = byId.get(row.conversationId);
    return record == null ? row : {
      ...row, title: record.durable.title ?? row.title,
      durable: record.durable, deletion: record.deletion, isSavedClosed: false,
    };
  });
  const opened = new Set(openRows.map((row) => row.conversationId));
  for (const record of saved) {
    const durable = record.durable;
    if (!opened.has(durable.conversationId)) {
      rows.push({
        conversationId: durable.conversationId,
        tabId: `sidechat:${durable.conversationId}`,
        title: durable.title ?? "Side chat",
        isResponseInProgress: false,
        durable, deletion: record.deletion, isSavedClosed: true,
      });
    }
  }
  return rows;
}

/** Capture all own Error fields, including message/stack, instead of JSON's empty Error object. */
export function errorJSON(error) {
  if (!(error instanceof Error)) return error;
  return Object.fromEntries(
    Object.getOwnPropertyNames(error).map((key) => [key, error[key]]),
  );
}

/**
 * Register a finally logger before starting each added RPC call.
 * One JSON string faithfully contains the original JSON request, result, and error.
 * Capture the request first so later mutations cannot change the recorded input.
 */
export async function loggedRpc(method, params, invoke, logger = console.info) {
  const request = JSON.parse(JSON.stringify(params));
  let response = null;
  let error = null;
  try {
    response = await invoke();
    return response;
  } catch (caught) {
    error = errorJSON(caught);
    throw caught;
  } finally {
    logger(JSON.stringify({ component: "codex-side-chat-patch", method, request, response, error }));
  }
}

/**
 * Read every inherited turn ID from the fork before accepting the first side user turn.
 * itemsView=notLoaded avoids copying message bodies and works with the pinned CLI schema.
 * Request currency is checked around every await; repeated cursors fail instead of looping.
 */
export async function inheritedBoundary(sendRequest, conversationId, assertCurrent) {
  const ids = new Set();
  const cursors = new Set();
  let cursor = null;
  do {
    assertCurrent();
    const params = {
      threadId: conversationId,
      cursor,
      limit: 100,
      itemsView: "notLoaded",
      sortDirection: "asc",
    };
    const page = await loggedRpc(
      "thread/turns/list",
      params,
      () => sendRequest("thread/turns/list", params),
    );
    assertCurrent();
    if (!Array.isArray(page.data)) throw new Error("Invalid native turn page");
    for (const turn of page.data) {
      if (typeof turn.id !== "string") throw new Error("Invalid native turn ID");
      ids.add(turn.id);
    }
    cursor = page.nextCursor ?? null;
    if (cursor != null && cursors.has(cursor)) throw new Error("Native turn cursor repeated");
    cursors.add(cursor);
  } while (cursor != null);
  return [...ids];
}

/** Replies are ephemeral signals; no receipt keys are retained in the renderer KV cache. */
const ACK_PREFIX = "codex-native-side-chat-ack-v1:";
/**
 * Mutation commands use request-scoped transient keys so the durable registry key always contains
 * a validated snapshot. Native KV publication is renderer-visible before main-process interception.
 */
export const MUTATION_PREFIX = "codex-native-side-chat-mutation-v1:";
/** One active deletion per native thread per renderer; shared main state owns cross-window claims. */
const activeDeletions = new Map();
/** Attach one listener to each local manager, with parent scope bindings for live tab cleanup. */
const deletionManagers = new WeakMap();
/** Native notifications preserve success evidence even when their KV flush races an RPC error. */
const nativeDeletionEvidence = new Set();

/**
 * Publish mutation commands without optimistic whole-registry replacement. Native main replies
 * only after flushOrThrow; timeout preserves pending intent and cannot authorize a delete RPC.
 */
export function mutationStorage({ readValue, publish, subscribe, clearReply, timeoutMs = 30000 }) {
  return {
    readValue,
    /** Resolve only the matching main-process request receipt, then release all temporary state. */
    commit(mutation) {
      const requestId = crypto.randomUUID();
      const operationId = mutation.operationId ?? crypto.randomUUID();
      const commandKey = MUTATION_PREFIX + requestId;
      return new Promise((resolve, reject) => {
        let stop;
        let timer;
        /** Release the one-shot subscription regardless of acknowledgement, timeout or publish error. */
        const finish = (error, value) => {
          clearTimeout(timer);
          stop?.();
          clearReply?.(ACK_PREFIX + requestId);
          clearReply?.(commandKey);
          error == null ? resolve(value) : reject(error);
        };
        stop = subscribe(ACK_PREFIX + requestId, (ack) => {
          if (ack?.requestId !== requestId || ack.operationId !== operationId) return;
          finish(ack.ok ? null : Object.assign(
            Error(ack.error?.message ?? "Could not save the side-chat change"),
            { sideMutationUncertain: true },
          ), ack.value);
        });
        timer = setTimeout(() => finish(Object.assign(
          Error("The side-chat change has not been confirmed; retry after reconnecting"),
          { sideMutationUncertain: true },
        )), timeoutMs);
        try {
          publish(commandKey, {
            kind: "codex-side-mutation-v1", requestId,
            mutation: { ...mutation, operationId },
          });
        } catch (error) { finish(error); }
      });
    },
  };
}

/** Check current ownership immediately before a destructive operation; parent IDs are forbidden. */
function ownedRecord(storage, durable, readIdentity) {
  const { accountId, userId } = readIdentity();
  assertIdentity(durable, accountId, userId);
  const record = readRegistry(storage).records[durable.conversationId];
  if (durable.hostId !== "local" || durable.conversationId === durable.sourceConversationId ||
      record == null ||
      ["accountId", "userId", "sourceConversationId", "hostId"]
        .some((key) => record.durable[key] !== durable[key])) {
    throw Error("This saved side chat is no longer available");
  }
  return record;
}

/** Recognize only the exact pinned engine's missing-rollout error for this target UUID. */
export function missingDeletedThread(error, conversationId) {
  return (error?.jsonRpcCode ?? error?.code) === -32600 &&
    error?.message === `no rollout found for thread id ${conversationId}`;
}

/** Release only the target's retained display boundary; canonical history stays native-owned. */
function releaseBoundary(record) {
  for (const ids of inheritedBoundaries.keys()) {
    if (inheritedOwners.get(ids) !== record.durable.conversationId) continue;
    inheritedBoundaries.delete(ids);
    inheritedOwners.delete(ids);
    cachedBoundaryIds -= ids.length;
  }
}

/**
 * Complete a user-confirmed deletion, or continue its durable operation after a restart.
 * Native success is never undone because live layout or KV cleanup failed. Definitive native
 * RPC errors release only the matching requested claim; transport ambiguity retains intent.
 */
export function permanentlyDelete({ storage, durable, manager, readIdentity, cleanup, nativeEvidence = false }) {
  const id = durable.conversationId;
  if (activeDeletions.has(id)) return activeDeletions.get(id);
  const work = (async () => {
    let record = ownedRecord(storage, durable, readIdentity);
    const operationId = record.deletion?.operationId ?? crypto.randomUUID();
    if (record.deletion == null) {
      await storage.commit({ action: "request-delete", durable, operationId });
    }
    record = ownedRecord(storage, durable, readIdentity);
    if (record.deletion?.operationId !== operationId) throw Error("Deletion ownership changed");
    if (record.deletion.phase !== "native-deleted" &&
        !nativeEvidence && !nativeDeletionEvidence.has(id)) {
      const params = { threadId: id };
      try {
        await loggedRpc("thread/delete", params, () => {
          ownedRecord(storage, durable, readIdentity);
          return manager.sendRequest("thread/delete", params);
        });
      } catch (error) {
        if (!missingDeletedThread(error, id) && !nativeDeletionEvidence.has(id)) {
          const latest = readRegistry(storage).records[id];
          if (latest?.deletion?.phase !== "native-deleted") {
            if (typeof (error?.jsonRpcCode ?? error?.code) === "number") {
              await storage.commit({ action: "cancel-delete", durable, operationId });
            }
            throw error;
          }
        }
      }
    }
    // Identity can change while native deletion runs; its evidence is safe to persist, but a
    // newly signed-in identity must not initiate cleanup or another RPC for the captured owner.
    await storage.commit({ action: "native-deleted", durable, operationId });
    ownedRecord(storage, durable, readIdentity);
    await cleanup(durable);
    await storage.commit({ action: "finish-delete", durable, operationId });
    releaseBoundary(record);
    nativeDeletionEvidence.delete(id);
  })().finally(() => {
    if (activeDeletions.get(id) === work) activeDeletions.delete(id);
  });
  activeDeletions.set(id, work);
  return work;
}

/**
 * Bind native notifications and native KV updates once per local host manager. Parent scopes
 * are registered only while mounted. Registry updates perform live cleanup in every window;
 * recovery RPCs run only on parent-open, identity or reconnect events, never by polling.
 */
export function bindDeletionManager(manager, { storage, readIdentity, cleanup, subscribe }) {
  let binding = deletionManagers.get(manager);
  if (binding != null) return binding;
  /** Mounted scopes own their layout callbacks; disposal removes all native subscriptions. */
  const cleanups = new Set();
  /** Record notifications that raced an in-flight delete response within this renderer. */
  const evidence = new Set();
  /** Run matching live cleanup callbacks even after another window removed the registry row. */
  const clean = async (durable) => {
    for (const callback of cleanups) await callback(durable);
  };
  /** Continue only explicit saved intent for the current account; no ordinary chats are scanned. */
  const recover = () => {
    if (manager.disposed) return;
    const identity = readIdentity();
    for (const record of Object.values(readRegistry(storage).records)) {
      if (!record.deletion || record.durable.accountId !== identity.accountId ||
          record.durable.userId !== identity.userId) continue;
      permanentlyDelete({
        storage, durable: record.durable, manager, readIdentity, cleanup: clean,
        nativeEvidence: evidence.has(record.durable.conversationId),
      }).catch((error) => console.error(JSON.stringify({
        component: "codex-side-chat-patch", operation: "recover-delete", error: errorJSON(error),
      })));
    }
  };
  let previous = readRegistry(storage);
  /** Close pending/deleted tabs in every bound window without starting retry loops on KV updates. */
  const changed = () => {
    const current = readRegistry(storage);
    const identity = readIdentity();
    for (const [id, record] of Object.entries(previous.records)) {
      if ((current.records[id]?.deletion?.phase === "native-deleted" || current.records[id] == null) &&
          record.durable.accountId === identity.accountId && record.durable.userId === identity.userId) {
        clean(record.durable).catch((error) => console.error(errorJSON(error)));
      }
    }
    previous = current;
  };
  const stopRegistry = subscribe(changed);
  const stopDeleted = manager.addThreadDeletedListener((id) => {
    const record = readRegistry(storage).records[id];
    if (record == null) return;
    const identity = readIdentity();
    if (record.durable.accountId !== identity.accountId || record.durable.userId !== identity.userId) return;
    evidence.add(id);
    nativeDeletionEvidence.add(id);
    if (record.deletion != null) {
      storage.commit({
        action: "native-deleted", durable: record.durable,
        operationId: record.deletion.operationId,
      }).catch((error) => console.error(errorJSON(error)));
    }
    permanentlyDelete({
      storage, durable: record.durable, manager, readIdentity, cleanup: clean, nativeEvidence: true,
    }).then(() => evidence.delete(id)).catch((error) => console.error(errorJSON(error)));
  });
  binding = {
    recover, cleanup: clean,
    /** Register a mounted parent and immediately continue its previously confirmed deletions. */
    register(callback = cleanup) {
      cleanups.add(callback);
      recover();
      return () => cleanups.delete(callback);
    },
    /** Release subscriptions with the native manager so retired windows retain no scope callbacks. */
    dispose() {
      stopRegistry(); stopDeleted(); cleanups.clear(); evidence.clear();
      deletionManagers.delete(manager);
    },
  };
  manager.cleanup.push(() => binding.dispose());
  deletionManagers.set(manager, binding);
  return binding;
}

/** Reuse an already-bound manager on native connection recovery; unmounted hosts do no new work. */
export function recoverDeletions(manager) {
  deletionManagers.get(manager)?.recover();
}

/** Reject added user turns, steering and restores while the durable deletion claim is present. */
export function guardSideRequest(storage, hostId, method, params) {
  if (hostId !== "local" ||
      !["turn/start", "turn/steer", "thread/resume", "thread/inject_items",
        "thread/queuedMessages/add", "thread-follower-start-turn",
        "thread-follower-steer-turn"].includes(method)) return;
  const id = params?.threadId ?? params?.conversationId;
  if (readRegistry(storage).records[id]?.deletion ||
      storage.readValue(DELETED_KEY)?.[id]) {
    throw Error("The side chat is being permanently deleted");
  }
}

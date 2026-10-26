/**
 * Versioned renderer helpers for native local side chats.
 * The supplied storage is Codex's existing persistent KV, never a second transcript store.
 */
export const REGISTRY_KEY = "codex-native-side-chats-v1";
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
      typeof record.hidden !== "boolean"
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
 * Existing boundary IDs and the creation timestamp survive title updates and reopen.
 */
export function remember(storage, durable, inheritedTurnIds) {
  const index = readRegistry(storage);
  const previous = index.records[durable.conversationId];
  const descriptor = { ...durable, collaborationMode: durable.collaborationMode ?? null };
  const boundary = inheritedTurnIds ?? previous?.inheritedTurnIds ?? [];
  if (
    previous != null && !previous.hidden && sameDescriptor(previous.durable, descriptor) &&
    (boundary === previous.inheritedTurnIds ||
      (boundary.length === previous.inheritedTurnIds.length &&
        boundary.every((id, position) => id === previous.inheritedTurnIds[position])))
  ) {
    return;
  }
  const record = {
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
}

/** Hide a closed panel without deleting its native rollout or its discovery relation. */
export function hide(storage, conversationId) {
  const index = readRegistry(storage);
  const record = index.records[conversationId];
  if (record == null || record.hidden) return;
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
  let rows = openRows;
  const opened = new Set(openRows.map((row) => row.conversationId));
  for (const record of saved) {
    const durable = record.durable;
    if (!opened.has(durable.conversationId)) {
      if (rows === openRows) rows = [...openRows];
      rows.push({
        conversationId: durable.conversationId,
        tabId: `sidechat:${durable.conversationId}`,
        title: durable.title ?? "Side chat",
        isResponseInProgress: false,
        durable,
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

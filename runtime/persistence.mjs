/**
 * Versioned renderer helpers for native local side chats.
 * The supplied storage is Codex's existing persistent KV, never a second transcript store.
 */
export const REGISTRY_KEY = "codex-native-side-chats-v1";

/**
 * Read the relation index without overwriting an unknown schema or damaged value.
 * Each record contains a native durable descriptor, inherited turn IDs (display only),
 * a hidden flag, and creation/update timestamps. No message text is copied here.
 */
export function readRegistry(storage) {
  const value = storage.readValue(REGISTRY_KEY);
  if (value == null) return { version: 1, records: {} };
  if (value.version !== 1 || !value.records || Array.isArray(value.records)) {
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
  return value;
}

/**
 * Persist a relation before exposing the thread in a panel.
 * Descriptor fields follow the original application's nullable collaborationMode schema.
 * Existing boundary IDs and the creation timestamp survive title updates and reopen.
 */
export function remember(storage, durable, inheritedTurnIds) {
  const index = readRegistry(storage);
  const previous = index.records[durable.conversationId];
  const record = {
    durable: { ...durable, collaborationMode: durable.collaborationMode ?? null },
    inheritedTurnIds: inheritedTurnIds ?? previous?.inheritedTurnIds ?? [],
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
  if (record == null) return;
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
  const inherited = new Set(record.inheritedTurnIds);
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
  const inherited = new Set(record.inheritedTurnIds);
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
  const rows = [...openRows];
  const opened = new Set(openRows.map((row) => row.conversationId));
  for (const record of Object.values(index?.records ?? {})) {
    const durable = record.durable;
    if (
      durable.hostId === "local" &&
      durable.accountId === accountId &&
      durable.userId === userId &&
      durable.sourceConversationId === sourceConversationId &&
      !opened.has(durable.conversationId)
    ) {
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

/** Native manager and panel symbols below belong to the hash-pinned build 24614 module graph. */

/**
 * Subscribe hydrated and final sidebar title families to owned registry/account/user snapshots.
 * Passing the explicit undefined family key is required by the native persisted-family API.
 * Remote hosts keep their original title selector and acquire no registry dependency.
 */
function codexSidePatchTitle(get, hostId, conversationId) {
  if (hostId !== "local") return null;
  const identity = n("SPnB");
  return __scp.savedSideTitle(get(codexSidePatchRegistryAtom(), void 0), {
    hostId, conversationId,
    accountId: get(identity.chatGptAuthenticatedAccountId$),
    userId: get(identity.o8),
  });
}

/**
 * Subscribe catalog and hydrated sidebar rows to the same saved descriptor as side-panel tabs.
 * The runtime preserves native task references unless this local row needs a different title.
 */
function codexSidePatchSidebarTask(get, task) {
  if (task?.kind !== "local" || task.summary?.hostId !== "local") return task;
  const identity = n("SPnB");
  return __scp.sidebarTask(get(codexSidePatchRegistryAtom(), void 0), task, {
    accountId: get(identity.chatGptAuthenticatedAccountId$),
    userId: get(identity.o8),
  });
}

/**
 * Preserve Codex's normal first-turn guard for ordinary threads. Saved side chats compare their
 * loaded canonical turn IDs with the persisted inherited boundary before accepting one title.
 */
function codexSidePatchIsFirstTurn(scope, conversationId) {
  const storage = codexSidePatchStorage();
  const record = __scp.readRegistry(storage).records[conversationId];
  const signals = n("tl5a");
  if (record == null) return (scope.get(signals.VT, conversationId) ?? 0) === 0;
  const identity = n("SPnB");
  __scp.assertUsable(
    storage,
    record.durable,
    scope.get(identity.chatGptAuthenticatedAccountId$),
    scope.get(identity.o8),
  );
  if (record.naming?.phase === "content") return false;
  const conversation = (0, n("Dgwo").V)(scope, "local").getConversation(conversationId);
  return __scp.shouldNameFirstTurn(
    storage,
    conversationId,
    conversation == null ? null : P(conversation),
  );
}

/** Update both panel targets after native main confirms the registry title mutation. */
function __codexSideSyncTitle(scope, durable) {
  const identity = n("SPnB");
  if (
    ![durable.sourceConversationId, durable.conversationId]
      .includes(scope.value.conversationId) ||
    durable.accountId !== scope.get(identity.chatGptAuthenticatedAccountId$) ||
    durable.userId !== scope.get(identity.o8)
  ) return;
  const record = __scp.readRegistry(codexSidePatchStorage()).records[durable.conversationId];
  if (record == null || record.deletion || record.durable.title == null) return;
  const title = record.durable.title;
  const panels = n("XXJV");
  for (const target of ["right", "bottom"]) {
    const controller = panels.getThreadPanelTabController(target);
    const tab = scope.get(controller.tabById$, `sidechat:${durable.conversationId}`);
    if (tab == null || tab.props?.content?.hostId !== "local") continue;
    const content = tab.props.content;
    if (
      tab.title === title &&
      tab.durableRoute?.params?.title === title &&
      content.durable?.title === title
    ) continue;
    controller.updateTab(scope, tab.tabId, {
      title,
      durableRoute: tab.durableRoute == null ? void 0 : {
        ...tab.durableRoute,
        params: { ...tab.durableRoute.params, title },
      },
      props: {
        ...tab.props,
        content: {
          ...content,
          durable: { ...content.durable, ...record.durable },
        },
      },
    });
  }
}

/** Persist the native Markdown-cleaned first response title once, then update live panel chrome. */
async function codexSidePatchNameFirstTurn(scope, conversationId, title) {
  const storage = codexSidePatchStorage();
  const durable = __scp.readRegistry(storage).records[conversationId]?.durable;
  const identity = n("SPnB");
  __scp.assertUsable(
    storage,
    durable,
    scope.get(identity.chatGptAuthenticatedAccountId$),
    scope.get(identity.o8),
  );
  if (durable == null) throw Error("The saved side chat no longer exists");
  const updated = await __scp.nameFirstTurn(storage, durable, title);
  __scp.assertUsable(
    storage,
    updated,
    scope.get(identity.chatGptAuthenticatedAccountId$),
    scope.get(identity.o8),
  );
  __codexSideSyncTitle(scope, updated);
}

/**
 * Use the native main mutation channel for manual rename/undo/redo, checking identity again after
 * disk confirmation. Return the allocated title to native menu callbacks and sync both panels.
 */
async function codexSidePatchRename(scope, conversationId, title) {
  const storage = codexSidePatchStorage();
  const durable = __scp.readRegistry(storage).records[conversationId]?.durable;
  if (durable == null) throw Error("The saved side chat no longer exists");
  const identity = n("SPnB");
  __scp.assertUsable(storage, durable,
    scope.get(identity.chatGptAuthenticatedAccountId$), scope.get(identity.o8));
  const updated = await __scp.renameSide(storage, durable, title);
  __scp.assertUsable(storage, updated,
    scope.get(identity.chatGptAuthenticatedAccountId$), scope.get(identity.o8));
  __codexSideSyncTitle(scope, updated);
  return updated.title;
}

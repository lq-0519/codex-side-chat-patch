/** Native module IDs below are valid only in the hash-pinned build 24614 Rspack graph. */
var __codexSideDeleteBindings = new WeakMap();
/** Open tabs retain cleanup registration while their parent summary is collapsed. */
var __codexSideDeleteTabScopes = new WeakMap();

/** Remove live tabs, persisted routes and the native parent-child relation for one verified side. */
function __codexSideCleanTabs(scope, durable) {
  if (scope.value.conversationId !== durable.sourceConversationId) return;
  const panels = n("XXJV");
  const ids = new Set([`sidechat:${durable.conversationId}`]);
  for (const target of ["right", "bottom"]) {
    const controller = panels.getThreadPanelTabController(target);
    for (const tab of scope.get(controller.tabs$)) {
      const content = tab.props?.content;
      if (
        !ids.has(tab.tabId) &&
        !(content?.hostId === "local" && content.conversationId === durable.conversationId)
      ) continue;
      ids.add(tab.tabId);
      controller.updateTab(scope, tab.tabId, { onBeforeClose: void 0, onClose: void 0 });
      controller.closeTab(scope, tab.tabId, { recordCloseUndo: false });
      if (scope.get(controller.tabById$, tab.tabId) != null) {
        throw Error("The deleted side-chat panel could not close; retry deletion cleanup");
      }
    }
  }
  __codexSideDeleteTabScopes.get(scope)?.get(durable.conversationId)?.();
  n("Exwq").V1(scope, durable.sourceConversationId, [...ids]);
  n("Ioto").ux(scope, durable.sourceConversationId, durable.conversationId);
}

/** Bind deletion recovery once to the native local manager and current identity signals. */
function __codexSideDeleteBinding(scope) {
  const manager = (0, n("Dgwo").V)(scope, "local");
  let binding = __codexSideDeleteBindings.get(manager);
  if (binding == null) {
    const identity = n("SPnB");
    binding = __scp.bindDeletionManager(manager, {
      storage: codexSidePatchStorage(),
      readIdentity: () => ({
        accountId: scope.get(identity.chatGptAuthenticatedAccountId$),
        userId: scope.get(identity.o8),
      }),
      subscribe: (callback) => n("kpIY").w5(__scp.REGISTRY_KEY, void 0, callback),
    });
    __codexSideDeleteBindings.set(manager, binding);
  }
  return { manager, binding };
}

/** Register one mounted parent so persisted deletion notifications repair its panel layout. */
function codexSidePatchRegisterDeletionScope(scope) {
  const { binding } = __codexSideDeleteBinding(scope);
  return binding.register((durable) => __codexSideCleanTabs(scope, durable));
}

/** Register one open tab for deletion cleanup and cross-window title synchronization. */
function codexSidePatchRegisterDeletionTab(scope, durable) {
  let tabs = __codexSideDeleteTabScopes.get(scope);
  if (tabs == null) __codexSideDeleteTabScopes.set(scope, tabs = new Map());
  tabs.get(durable.conversationId)?.();
  const stop = codexSidePatchRegisterDeletionScope(scope);
  const syncTitle = () => __codexSideSyncTitle(scope, durable);
  const stopTitle = n("kpIY").w5(__scp.REGISTRY_KEY, void 0, syncTitle);
  syncTitle();
  /** A retired tab cannot unregister a newer replacement for the same native conversation. */
  const release = () => {
    stop();
    stopTitle();
    if (tabs.get(durable.conversationId) === release) tabs.delete(durable.conversationId);
  };
  tabs.set(durable.conversationId, release);
  return release;
}

/** Revalidate ownership immediately before the user-confirmed destructive RPC transaction. */
function codexSidePatchDelete(scope, durable) {
  const identity = n("SPnB");
  const { manager, binding } = __codexSideDeleteBinding(scope);
  return __scp.permanentlyDelete({
    storage: codexSidePatchStorage(),
    durable,
    manager,
    readIdentity: () => ({
      accountId: scope.get(identity.chatGptAuthenticatedAccountId$),
      userId: scope.get(identity.o8),
    }),
    cleanup: binding.cleanup,
  });
}

/** Native module IDs below are valid only in the hash-pinned build 25894 Rspack graph. */
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

/**
 * Bind deletion recovery to the native asynchronous RPC facade for a mounted parent scope.
 * Connection/identity signals reattach the native thread-deleted event after a host reconnect.
 * The last mounted summary/tab releases both native handles and the registry subscription.
 */
function __codexSideDeleteBinding(scope) {
  let entry = __codexSideDeleteBindings.get(scope);
  if (entry == null) {
    const identity = n("SPnB"), connection = n("l00C");
    /** Adapt only the deletion operations; no conversation cache or transcript is copied. */
    const manager = {
      disposed: false,
      cleanup: [],
      sendRequest: (method, params) => (0, n("Dgwo").V)(scope, "local")
        .sendRequest(method, params),
      /** Subscribe through native RPC and release handles even if setup finishes after unmount. */
      addThreadDeletedListener(callback) {
        let active = true, generation = 0, handle, lastRpc, lastAccount, lastUser;
        /** Native RPC handles implement Symbol.dispose; disposal also cancels their callbacks. */
        const release = value => value?.[Symbol.dispose]();
        const stop = scope.watch(({ get }) => {
          const state = get(connection.VN, "local");
          const accountId = get(identity.chatGptAuthenticatedAccountId$);
          const userId = get(identity.o8);
          if (state.status !== "ready") {
            generation++; release(handle); handle = lastRpc = void 0;
            return;
          }
          const rpc = (0, n("Dgwo").V)(scope, "local");
          if (rpc === lastRpc && accountId === lastAccount && userId === lastUser) return;
          const ticket = ++generation;
          release(handle); handle = void 0;
          lastRpc = rpc; lastAccount = accountId; lastUser = userId;
          const pending = rpc.subscribe({
            type: "event", key: { hostId: "local" }, event: "thread-deleted",
            listener: id => { if (active && ticket === generation) callback(id); },
          });
          pending.then(value => {
            if (!active || ticket !== generation) return release(value);
            handle = value;
            __scp.recoverDeletions(manager);
          }, error => {
            if (active && ticket === generation) console.error(__scp.errorJSON(error));
          });
        });
        return () => { active = false; generation++; stop(); release(handle); };
      },
    };
    const binding = __scp.bindDeletionManager(manager, {
      storage: codexSidePatchStorage(),
      readIdentity: () => ({
        accountId: scope.get(identity.chatGptAuthenticatedAccountId$),
        userId: scope.get(identity.o8),
      }),
      subscribe: (callback) => n("kpIY").w5(__scp.REGISTRY_KEY, void 0, callback),
    });
    entry = { manager, binding, references: 0 };
    __codexSideDeleteBindings.set(scope, entry);
  }
  return entry;
}

/** Register one mounted parent so persisted deletion notifications repair its panel layout. */
function codexSidePatchRegisterDeletionScope(scope) {
  const entry = __codexSideDeleteBinding(scope);
  entry.references++;
  const stop = entry.binding.register((durable) => __codexSideCleanTabs(scope, durable));
  let active = true;
  return () => {
    if (!active) return;
    active = false; stop();
    if (--entry.references !== 0) return;
    entry.manager.disposed = true;
    entry.binding.dispose();
    entry.manager.cleanup.length = 0;
    __codexSideDeleteBindings.delete(scope);
  };
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

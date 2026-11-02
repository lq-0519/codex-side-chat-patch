/** Native symbols below are valid only in the hash-pinned app-initial build 24141. */
var __codexSideDeleteBindings = new WeakMap();
/** Open tabs retain cleanup registration even while the parent summary section is collapsed. */
var __codexSideDeleteTabScopes = new WeakMap();

/** Reuse the original right/bottom controllers, bypassing voice and ordinary-close callbacks. */
function __codexSideCleanTabs(scope, durable) {
  if (scope.value.conversationId !== durable.sourceConversationId) return;
  const ids = new Set([`sidechat:${durable.conversationId}`]);
  for (const target of [`right`, `bottom`]) {
    const controller = LU(target);
    for (const tab of scope.get(controller.tabs$)) {
      const content = tab.props?.content;
      if (!ids.has(tab.tabId) &&
          !(content?.hostId === `local` && content.conversationId === durable.conversationId)) continue;
      ids.add(tab.tabId);
      controller.updateTab(scope, tab.tabId, { onBeforeClose: void 0, onClose: void 0 });
      controller.closeTab(scope, tab.tabId, { recordCloseUndo: false });
      if (scope.get(controller.tabById$, tab.tabId) != null) {
        throw Error(`The deleted side-chat panel could not close; retry deletion cleanup`);
      }
    }
  }
  __codexSideDeleteTabScopes.get(scope)?.get(durable.conversationId)?.();
  // t_i filters inactive saved routes and repairs focus/active tabs; native main repeats
  // the same filtering at the flush boundary and on late stale layout publishes.
  t_i(scope, durable.sourceConversationId, [...ids]);
  // Vvi removes one relation through the native relation signal family. Its initializer is not
  // itself a signal and cannot be passed to scope.set during cleanup.
  Vvi(scope, durable.sourceConversationId, durable.conversationId);
}

/** Bind deletion to the native local manager and the current account/user signals once. */
function __codexSideDeleteBinding(scope) {
  const manager = Jh(scope, `local`);
  let binding = __codexSideDeleteBindings.get(manager);
  if (binding == null) {
    binding = __scp.bindDeletionManager(manager, {
      storage: codexSidePatchStorage(),
      readIdentity: () => ({ accountId: scope.get(p_), userId: scope.get(K_) }),
      subscribe: (callback) => I_(__scp.REGISTRY_KEY, void 0, callback),
    });
    __codexSideDeleteBindings.set(manager, binding);
  }
  return { manager, binding };
}

/** Mount-only registration lets KV/deleted notifications repair this parent window's panels. */
export function codexSidePatchRegisterDeletionScope(scope) {
  const { binding } = __codexSideDeleteBinding(scope);
  return binding.register((durable) => __codexSideCleanTabs(scope, durable));
}

/** Release tab-specific scope registration on ordinary close and successful delete cleanup. */
export function codexSidePatchRegisterDeletionTab(scope, durable) {
  let tabs = __codexSideDeleteTabScopes.get(scope);
  if (tabs == null) __codexSideDeleteTabScopes.set(scope, tabs = new Map());
  tabs.get(durable.conversationId)?.();
  const stop = codexSidePatchRegisterDeletionScope(scope);
  /** Native KV events synchronize names only while this tab exists, with no polling or timers. */
  const syncTitle = () => __codexSideSyncTitle(scope, durable);
  const stopTitle = I_(__scp.REGISTRY_KEY, void 0, syncTitle);
  syncTitle();
  /** The identity check prevents an old replaced tab from unregistering its new replacement. */
  const release = () => {
    stop();
    stopTitle();
    if (tabs.get(durable.conversationId) === release) tabs.delete(durable.conversationId);
  };
  tabs.set(durable.conversationId, release);
  return release;
}

/** Confirmed UI submission revalidates ownership through the runtime before issuing any RPC. */
export function codexSidePatchDelete(scope, durable) {
  const { manager, binding } = __codexSideDeleteBinding(scope);
  return __scp.permanentlyDelete({
    storage: codexSidePatchStorage(), durable, manager,
    readIdentity: () => ({ accountId: scope.get(p_), userId: scope.get(K_) }),
    cleanup: binding.cleanup,
  });
}

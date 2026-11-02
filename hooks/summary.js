/**
 * Merge plugin discovery with build 24141's original rows, including native attached children,
 * both panel targets, unread state and menu metadata. The KV family requires an explicit key.
 * Route scope supplies the parent ID; root signals supply the signed-in account and user.
 */
({ get, scope }, nativeRows) => __scp.summaryRows(
  get(__sideRegistryAtom(), void 0),
  nativeRows,
  {
    accountId: get(__sideAccount),
    userId: get(__sideUser),
    sourceConversationId: scope.value.conversationId,
  },
)

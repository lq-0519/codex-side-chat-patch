/**
 * Merge compatibility-registry rows with build 25241's native attached-thread discovery.
 * Native open rows retain unread state and menu metadata; only closed historical rows are added.
 */
({ get, scope }, nativeRows) => __scp.summaryRows(
  get(n("V7mA").codexSidePatchRegistryAtom(), void 0),
  nativeRows,
  {
    accountId: get(n("SPnB").chatGptAuthenticatedAccountId$),
    userId: get(n("SPnB").o8),
    sourceConversationId: scope.value.conversationId,
  },
)

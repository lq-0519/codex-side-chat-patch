/**
 * Read saved relations through the application's native KV signal family, then merge its
 * original open-tab rows. uv returns a family, so get must receive an explicit undefined key;
 * a one-argument read incorrectly asks the family for an atom resolve method and breaks the
 * summary panel. Route scope supplies the parent ID; root signals supply account and user.
 * CO remains the original tab-to-row converter and za the original in-progress family.
 */
({ get, scope }) => __scp.summaryRows(
  get(__sideRegistryAtom(), void 0),
  CO(get(Ju.tabs$), conversationId => get(za, conversationId) ?? false),
  {
    accountId: get(__sideAccount),
    userId: get(__sideUser),
    sourceConversationId: scope.value.conversationId,
  },
)

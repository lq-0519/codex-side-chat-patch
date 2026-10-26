/**
 * Read saved relations through the application's native KV signal family, then merge its
 * original open-tab rows. Ev returns a family, so get must receive an explicit undefined key;
 * a one-argument read incorrectly asks the family for an atom resolve method and breaks the
 * summary panel. Route scope supplies the parent ID; root signals supply account and user.
 * mO remains the original tab-to-row converter and su the original in-progress family.
 */
({ get, scope }) => __scp.summaryRows(
  get(__sideRegistryAtom(), void 0),
  mO(get(Vo.tabs$), conversationId => get(su, conversationId) ?? false),
  {
    accountId: get(__sideAccount),
    userId: get(__sideUser),
    sourceConversationId: scope.value.conversationId,
  },
)

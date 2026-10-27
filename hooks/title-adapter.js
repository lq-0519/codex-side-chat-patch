/** Native signal/controller names below belong exclusively to the hash-pinned build 21828. */

/**
 * Translate canonical entity keys through the native turn-ID selector before comparing the
 * inherited boundary. Temporary hosts keep the original counter; saved local sides require
 * loaded canonical history and current ownership, without changing shared history selectors.
 */
export function codexSidePatchIsFirstTurn(scope, conversationId) {
  const storage = codexSidePatchStorage();
  const record = __scp.readRegistry(storage).records[conversationId];
  if (record == null) return (scope.get(r2n, conversationId) ?? 0) === 0;
  __scp.assertUsable(storage, record.durable, scope.get(q_), scope.get(Av));
  if (record.naming?.phase === "content") return false;
  const keys = scope.get(Aw, { hostId: `local`, threadId: conversationId });
  return __scp.shouldNameFirstTurn(storage, conversationId,
    keys?.map((key) => ({ turnId: scope.get(Nw, key) ?? key.entityKey })));
}

/**
 * Repair both panel targets using the confirmed registry descriptor. Updating visible title,
 * durableRoute and content.durable together preserves native serialize/retry/move behavior.
 * A stale ordinary-close closure is repaired again when its tab registers, while native main
 * protects layout writes. Matching identity/parent checks keep retired scopes from showing names.
 */
function __codexSideSyncTitle(scope, durable) {
  if (![durable.sourceConversationId, durable.conversationId].includes(scope.value.conversationId) ||
      durable.accountId !== scope.get(q_) || durable.userId !== scope.get(Av)) return;
  const record = __scp.readRegistry(codexSidePatchStorage()).records[durable.conversationId];
  if (record == null || record.deletion || record.durable.title == null) return;
  const title = record.durable.title;
  for (const target of [`right`, `bottom`]) {
    const controller = dG(target);
    const tab = scope.get(controller.tabById$, `sidechat:${durable.conversationId}`);
    if (tab == null || tab.props?.content?.hostId !== `local`) continue;
    const content = tab.props.content;
    if (tab.title === title && tab.durableRoute?.params?.title === title &&
        content.durable?.title === title) continue;
    controller.updateTab(scope, tab.tabId, {
      title,
      durableRoute: tab.durableRoute == null ? undefined : {
        ...tab.durableRoute, params: { ...tab.durableRoute.params, title },
      },
      props: { ...tab.props, content: {
        ...content, durable: { ...content.durable, ...record.durable },
      } },
    });
  }
}

/**
 * Native composer success supplies OI's existing Markdown-cleaned text. Persist once, then
 * update live chrome; other windows receive the same registry notification. A textless success
 * seals naming too, and every async boundary rechecks account/deletion before exposing a title.
 */
export async function codexSidePatchNameFirstTurn(scope, conversationId, title) {
  const storage = codexSidePatchStorage();
  const durable = __scp.readRegistry(storage).records[conversationId]?.durable;
  __scp.assertUsable(storage, durable, scope.get(q_), scope.get(Av));
  if (durable == null) throw Error(`The saved side chat no longer exists`);
  const updated = await __scp.nameFirstTurn(storage, durable, title);
  __scp.assertUsable(storage, updated, scope.get(q_), scope.get(Av));
  __codexSideSyncTitle(scope, updated);
}

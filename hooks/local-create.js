/**
 * Replacement for zt in build 21828 only; native symbol bindings come from the original asset.
 * Cloud/remote paths keep their original temporary behavior. Local forks use native persistence.
 * assertRequestCurrent prevents an identity-retired or cancelled creation becoming an orphan.
 */
async function zt({
  scope: e,
  sourceConversationId: t,
  threadSource: n,
  cwd: r,
  hostId: i,
  collaborationMode: a,
  instructionOverrides: o,
  parentNavigationPath: s,
  assertRequestCurrent,
  /** Native cleaned display text, or the localized placeholder, allocated atomically with the fork. */
  naming,
}) {
  if (f(i)) {
    let r = await Ct({
      scope: e, sourceConversationId: t, threadSource: n,
      collaborationMode: a, developerInstructions: bt, parentNavigationPath: s,
    });
    if (r == null) return null;
    if (r.status !== `created`) throw R(e, r);
    return { conversationId: r.conversationId, hostId: i, creation: r };
  }
  const persistent = i === `local`;
  const accountId = e.get(__sideAccount);
  const userId = e.get(__sideUser);
  /** Currency checks bind this fork to the identity and pending tab that requested it. */
  const current = () => {
    assertRequestCurrent?.();
    if (persistent && (accountId == null || userId == null ||
        accountId !== e.get(__sideAccount) || userId !== e.get(__sideUser))) {
      throw Error(`The signed-in identity changed before the side chat could open`);
    }
  };
  current();
  let [c, { instructions: l }] = await Promise.all([
    Ae(e, t),
    Le({
      cwd: r, hostId: i,
      ...(Ze(e, i, !0) ? { hostedAutomationsEnabled: !0 } : {}),
      includeProseDetailLevelInstructions: e.get(rt),
      instructionOverrides: o, threadId: t,
    }),
  ]);
  current();
  const params = {
    sourceConversationId: t, threadSource: n, cwd: r, workspaceRoots: c,
    collaborationMode: a, ephemeral: !persistent, addForkedSyntheticItem: !1,
    developerInstructions: `${l}\n\n${bt}

Scheduled updates can’t run in side chats. If the user asks for a recurring monitor here, explain that they should open the main chat or start a new chat, then set up the schedule there. Do not claim scheduled updates were set up in this side chat. Scheduling for another chat or a standalone task remains available.`,
    sideConversation: !0, sideConversationParentNavigationPath: s,
  };
  const u = await __scp.loggedRpc(`forkConversation`, params, () => ue(e, i, params));
  try {
    current();
    if (persistent && u.synchronization.status === `failed`) {
      throw Error(u.synchronization.message);
    }
    let durable;
    if (persistent) {
      const inheritedTurnIds = await __scp.inheritedBoundary(
        (method, params) => H(e, i).sendRequest(method, params), u.conversationId, current,
      );
      current();
      durable = {
        conversationId: u.conversationId, sourceConversationId: t, hostId: `local`,
        parentNavigationPath: s, accountId, userId, contextInjected: !0,
        collaborationMode: a ?? null, presentation: `side-chat`,
      };
      durable = await __scp.remember(__sideStorage(), durable, inheritedTurnIds, naming);
      current();
    }
    return {
      conversationId: u.conversationId, hostId: i, durable,
      creation: {
        status: `created`, conversationId: u.conversationId,
        firstTurn: u.synchronization.status === `failed`
          ? { status: `not-started`, message: u.synchronization.message }
          : { status: `not-requested` },
      },
    };
  } catch (error) {
    if (persistent) {
      const archiveParams = {
        conversationId: u.conversationId,
        options: { useAppServerPins: !1, source: `side-chat-cancelled` },
      };
      await __scp.loggedRpc(`archiveConversation`, archiveParams, () =>
        H(e, i).archiveConversation(u.conversationId, archiveParams.options));
      await __scp.forgetCancelled(__sideStorage(), u.conversationId);
    }
    throw error;
  }
}

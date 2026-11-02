/**
 * Replace build 24141's an using its hash-pinned native bindings. Local forks retain the
 * plugin's durable registry; other hosts keep the new native attachToSource capability gate.
 * Cancellation and identity checks surround each async boundary that can create saved data.
 */
async function an({
  scope, sourceConversationId, threadSource, cwd, hostId, collaborationMode,
  instructionOverrides, parentNavigationPath, assertRequestCurrent,
  /** Native cleaned text or localized placeholder, allocated atomically with the fork. */
  naming,
}) {
  if (a(hostId)) {
    const result = await zt({
      scope, sourceConversationId, threadSource, collaborationMode,
      developerInstructions: Et, parentNavigationPath,
    });
    if (result == null) return null;
    if (result.status !== `created`) throw L(scope, result);
    return { conversationId: result.conversationId, hostId, creation: result };
  }
  const persistent = hostId === `local`;
  const accountId = scope.get(__sideAccount);
  const userId = scope.get(__sideUser);
  /** Bind the fork to its original pending tab and signed-in account throughout creation. */
  const current = () => {
    assertRequestCurrent?.();
    if (persistent && (accountId == null || userId == null ||
        accountId !== scope.get(__sideAccount) || userId !== scope.get(__sideUser))) {
      throw Error(`The signed-in identity changed before the side chat could open`);
    }
  };
  current();
  const [workspaceRoots, { instructions }] = await Promise.all([
    Pt(scope, sourceConversationId),
    Mt({
      cwd, hostId,
      ...(Lt(scope, hostId, !0) ? { hostedAutomationsEnabled: !0 } : {}),
      includeProseDetailLevelInstructions: scope.get(Ze),
      instructionOverrides, threadId: sourceConversationId,
    }),
  ]);
  current();
  /** Native attached persistence remains separate from plugin-managed local saved threads. */
  const attached = !persistent && threadSource === `user` &&
    scope.get(Je, sourceConversationId) === `paginated` &&
    s(scope.get(xe, hostId), `persistentSideChats`) && scope.get(Pe, `1450837220`);
  const params = {
    sourceConversationId, threadSource, cwd, workspaceRoots, collaborationMode,
    ...(attached ? { attachToSource: !0 } : { ephemeral: !persistent }),
    addForkedSyntheticItem: !1,
    developerInstructions: persistent ? `${instructions}\n\n${Et}

Scheduled updates can’t run in side chats. If the user asks for a recurring monitor here, explain that they should open the main chat or start a new chat, then set up the schedule there. Do not claim scheduled updates were set up in this side chat. Scheduling for another chat or a standalone task remains available.` :
      [instructions, Et, ...(attached ? [] : [sn])].join(`\n\n`),
    sideConversation: !0, sideConversationParentNavigationPath: parentNavigationPath,
  };
  const result = await __scp.loggedRpc(`forkConversation`, params, () =>
    Ce(scope, hostId, params));
  try {
    current();
    if (persistent && result.synchronization.status === `failed`) {
      throw Error(result.synchronization.message);
    }
    let durable;
    if (persistent) {
      const inheritedTurnIds = await __scp.inheritedBoundary(
        (method, input) => U(scope, hostId).sendRequest(method, input),
        result.conversationId, current,
      );
      current();
      durable = {
        conversationId: result.conversationId, sourceConversationId, hostId: `local`,
        parentNavigationPath, accountId, userId, contextInjected: !0,
        collaborationMode: collaborationMode ?? null, presentation: `side-chat`,
      };
      durable = await __scp.remember(__sideStorage(), durable, inheritedTurnIds, naming);
      current();
    }
    return {
      conversationId: result.conversationId, hostId, durable,
      persistent: persistent ? !1 : !result.ephemeral,
      creation: {
        status: `created`, conversationId: result.conversationId,
        firstTurn: result.synchronization.status === `failed`
          ? { status: `not-started`, message: result.synchronization.message }
          : { status: `not-requested` },
      },
    };
  } catch (error) {
    if (persistent) {
      const archiveParams = {
        conversationId: result.conversationId,
        options: { useAppServerPins: !1, source: `side-chat-cancelled` },
      };
      await __scp.loggedRpc(`archiveConversation`, archiveParams, () =>
        U(scope, hostId).archiveConversation(result.conversationId, archiveParams.options));
      await __scp.forgetCancelled(__sideStorage(), result.conversationId);
    }
    throw error;
  }
}

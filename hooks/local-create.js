/**
 * Replace build 24614's AqOV.v. Local forks follow the new native persistent descriptor shape
 * while retaining the compatibility registry required for historical discovery and deletion.
 * Other hosts keep the native attached-or-temporary behavior unchanged.
 */
async function v({
  scope: e, sourceConversationId: t, threadSource: n, cwd: g, hostId: w,
  collaborationMode: y, instructionOverrides: I, parentNavigationPath: C,
  assertRequestCurrent: A, naming: R,
}) {
  if ((0, r.ZJQ)(w)) {
    const result = await (0, h.z)({
      scope: e, sourceConversationId: t, threadSource: n, collaborationMode: y,
      developerInstructions: f.R, parentNavigationPath: C,
    });
    if (result == null) return null;
    if (result.status !== "created") throw (0, d.c)(e, result);
    return { conversationId: result.conversationId, hostId: w, creation: result };
  }

  const persistent = w === "local";
  const accountId = e.get(__sideIdentity.chatGptAuthenticatedAccountId$);
  const userId = e.get(__sideIdentity.o8);
  /** Keep creation bound to the pending tab and identity captured before the first await. */
  const current = () => {
    A?.();
    if (persistent && (
      accountId == null || userId == null ||
      accountId !== e.get(__sideIdentity.chatGptAuthenticatedAccountId$) ||
      userId !== e.get(__sideIdentity.o8)
    )) {
      throw Error("The signed-in identity changed before the side chat could open");
    }
  };

  current();
  const [workspaceRoots, { instructions }] = await Promise.all([
    (0, c.A)(e, t),
    (0, l.Y)({
      cwd: g,
      hostId: w,
      ...(0, u.c)(e, w, true) ? { hostedAutomationsEnabled: true } : {},
      includeProseDetailLevelInstructions: e.get(p.e2),
      instructionOverrides: I,
      threadId: t,
    }),
  ]);
  current();

  const attached = !persistent && n === "user" && e.get(i.sX, t) === "paginated" &&
    (0, a.JF)(e.get(s.B, w), "persistentSideChats") && e.get(m.JW, "1450837220");
  const params = {
    sourceConversationId: t,
    threadSource: n,
    cwd: g,
    workspaceRoots,
    collaborationMode: y,
    ...(attached ? { attachToSource: true } : { ephemeral: !persistent }),
    addForkedSyntheticItem: false,
    developerInstructions: persistent
      ? `${instructions}\n\n${f.R}

Scheduled updates can’t run in side chats. If the user asks for a recurring monitor here, explain that they should open the main chat or start a new chat, then set up the schedule there. Do not claim scheduled updates were set up in this side chat. Scheduling for another chat or a standalone task remains available.`
      : [
          instructions,
          f.R,
          ...(attached ? [] : [
            "Scheduled updates can’t run in temporary side chats. If the user asks for a recurring monitor here, explain that they should open the main chat or start a new chat, then set up the schedule there. Do not claim scheduled updates were set up in this side chat. Scheduling for another chat or a standalone task remains available.",
          ]),
        ].join("\n\n"),
    sideConversation: true,
    sideConversationParentNavigationPath: C,
  };
  const result = await (0, o.y)(e, w, params);

  try {
    current();
    if (persistent && result.synchronization.status === "failed") {
      throw Error(result.synchronization.message);
    }
    let durable;
    if (persistent) {
      const inheritedTurnIds = await __scp.inheritedBoundary(
        (method, input) => (0, __sideManager.V)(e, w).sendRequest(method, input),
        result.conversationId,
        current,
      );
      current();
      durable = {
        conversationId: result.conversationId,
        sourceConversationId: t,
        hostId: "local",
        parentNavigationPath: C,
        accountId,
        userId,
        contextInjected: true,
        collaborationMode: y ?? null,
        presentation: "side-chat",
        patchVersion: 1,
      };
      durable = await __scp.remember(
        __side.codexSidePatchStorage(), durable, inheritedTurnIds, R,
      );
      current();
    }
    return {
      conversationId: result.conversationId,
      hostId: w,
      durable,
      persistent: persistent ? false : !result.ephemeral,
      creation: {
        status: "created",
        conversationId: result.conversationId,
        firstTurn: result.synchronization.status === "failed"
          ? { status: "not-started", message: result.synchronization.message }
          : { status: "not-requested" },
      },
    };
  } catch (error) {
    if (persistent) {
      const archiveParams = {
        conversationId: result.conversationId,
        options: { useAppServerPins: false, source: "side-chat-cancelled" },
      };
      await __scp.loggedRpc(
        "archiveConversation",
        archiveParams,
        () => (0, __sideManager.V)(e, w).archiveConversation(
          result.conversationId, archiveParams.options,
        ),
      );
      await __scp.forgetCancelled(
        __side.codexSidePatchStorage(), result.conversationId,
      );
    }
    throw error;
  }
}

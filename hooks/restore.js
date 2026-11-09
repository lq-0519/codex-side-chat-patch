/**
 * Replace build 25894's vBFC.q. Native resume owns workspace and server configuration; the
 * compatibility guard prevents deleted historical descriptors from reopening from stale layouts.
 */
async function codexSideRestore(e, t, sourceConversationId, r) {
  const a = __require("DBCl"), d = __require("SPnB"), l = __require("MLeN");
  const s = __require("Dgwo"), i = __require("shRG"), o = __require("vpsD");
  const __side = __require("V7mA");
  const hostId = t.hostId ?? a.iwv;
  /** Validate ownership and deletion state around every asynchronous native boundary. */
  const current = () => {
    if (t.accountId !== e.get(d.chatGptAuthenticatedAccountId$) ||
        t.userId !== e.get(d.o8)) {
      throw Error(e.get(__require("svjy").g).formatMessage({
        id: "localConversation.sideChat.workspaceChanged",
        defaultMessage: "The workspace changed before the side chat could open",
        description: "Error when the signed-in user or workspace changes while opening a saved Team side chat",
      }));
    }
    if (__scp.isManagedSide(__side.codexSidePatchStorage(), t)) {
      __scp.assertUsable(
        __side.codexSidePatchStorage(),
        t,
        e.get(d.chatGptAuthenticatedAccountId$),
        e.get(d.o8),
      );
    }
  };
  current();
  try {
    const params = {
      conversationId: t.conversationId,
      threadAccess: t.teamId == null ? void 0 : "shared",
      model: null,
      reasoningEffort: null,
      workspaceRoots: (0, a.ZJQ)(hostId)
        ? []
        : await (0, l.A)(e, sourceConversationId, { allowProjectSourceRoots: true }),
      preserveServerConfiguration: true,
      sideConversation: { parentNavigationPath: r },
    };
    current();
    const result = await __scp.loggedRpc(
      "resumeConversation",
      params,
      () => (0, s.V)(e, hostId).resumeConversation(
        params, { readResumeInputs: (0, i.jQ)(e, hostId) },
      ),
    );
    current();
    if (result.status !== "ready") throw new o.uZ(result);
    return { conversationId: t.conversationId, hostId, durable: t };
  } catch (error) {
    current();
    return {
      conversationId: t.conversationId,
      hostId,
      durable: t,
      setupError: Error((0, a.Rt_)(error)),
    };
  }
}

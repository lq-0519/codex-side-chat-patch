/**
 * Replace build 24614's vBFC.v. Native resume owns workspace and server configuration; the
 * compatibility guard prevents deleted historical descriptors from reopening from stale layouts.
 */
async function v(e, t, n, r) {
  const hostId = t.hostId ?? a.iwv;
  /** Validate ownership and deletion state around every asynchronous native boundary. */
  const current = () => {
    g(e, t);
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
        : await (0, l.A)(e, n, { allowProjectSourceRoots: true }),
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

/**
 * Resume the original durable descriptor with its explicitly recorded local host.
 * Native workspace checks, server permissions and account/user validation remain in force.
 */
async function H(e, t, n, a) {
  let o = t.hostId ?? `durable`;
  /** A descriptor cannot reopen after either deletion claim or index removal, including late RPCs. */
  const current = () => {
    U(e, t);
    __scp.assertUsable(__sideStorage(), t, e.get(__sideAccount), e.get(__sideUser));
  };
  current();
  try {
    const params = {
      conversationId: t.conversationId,
      threadAccess: t.teamId == null ? void 0 : `shared`,
      model: null,
      reasoningEffort: null,
      workspaceRoots: i(o) ? [] : await m(e, n, { allowProjectSourceRoots: !0 }),
      preserveServerConfiguration: !0,
      sideConversation: { parentNavigationPath: a },
    };
    current();
    const result = await __scp.loggedRpc(`resumeConversation`, params, () =>
      b(e, o).resumeConversation(params, { readResumeInputs: c(e, o) }));
    current();
    if (result.status !== `ready`) throw new d(result);
    return { conversationId: t.conversationId, hostId: o, durable: t };
  } catch (error) {
    current();
    return {
      conversationId: t.conversationId, hostId: o, durable: t,
      setupError: Error(r(error)),
    };
  }
}

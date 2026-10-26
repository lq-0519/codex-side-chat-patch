/**
 * Resume the original durable descriptor with its explicitly recorded local host.
 * Native workspace checks, server permissions and account/user validation remain in force.
 */
async function H(e, t, n, a) {
  let o = t.hostId ?? `durable`;
  const current = () => U(e, t);
  current();
  try {
    const params = {
      conversationId: t.conversationId,
      threadAccess: t.teamId == null ? void 0 : `shared`,
      model: null,
      reasoningEffort: null,
      workspaceRoots: r(o) ? [] : await d(e, n, { allowProjectSourceRoots: !0 }),
      preserveServerConfiguration: !0,
      sideConversation: { parentNavigationPath: a },
    };
    current();
    const result = await __scp.loggedRpc(`resumeConversation`, params, () =>
      S(e, o).resumeConversation(params, { readResumeInputs: f(e, o) }));
    current();
    if (result.status !== `ready`) throw new w(result);
    return { conversationId: t.conversationId, hostId: o, durable: t };
  } catch (error) {
    current();
    return {
      conversationId: t.conversationId, hostId: o, durable: t,
      setupError: Error(i(error)),
    };
  }
}

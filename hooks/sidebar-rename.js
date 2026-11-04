/**
 * Insert into native PAOI.B before its catalog/RPC branches. Saved side titles belong to the
 * registry, so native undo transitions mutate that descriptor and report the actual unique name.
 * Clean new user input with native t162.uw; restore the complete historical title on undo.
 */
{
  const hostId = n ?? e.get(p.qX, t);
  const storage = __side.codexSidePatchStorage();
  if (__scp.isManagedSide(storage, { hostId, conversationId: t })) {
    const title = __sideTitleClean(i, 60);
    if (title == null) return;
    const previous = __scp.readRegistry(storage).records[t]?.durable.title;
    /** Preserve native completion callbacks after the registry and both panels are confirmed. */
    const apply = async value => {
      const allocated = await __side.codexSidePatchRename(e, t, value);
      a?.(allocated);
    };
    return previous == null || previous === title ? apply(title) :
      (0, m.vJ)(e, {
        label: x.renameThreadUndone, transitionQueueKey: `thread-title:${hostId}:${t}`,
      }, { perform: () => apply(title), redo: () => apply(title), undo: () => apply(previous) });
  }
}

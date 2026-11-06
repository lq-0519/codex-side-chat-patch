/**
 * Reveal an accepted local right-side chat beside its parent instead of inheriting full width.
 * The native pending-tab open can enable both ordinary and workspace full-view signals. Clear
 * those signals through the pinned native panel APIs before fork/restore starts, without changing
 * the saved default or notifying the tab again. Background restores and other destinations retain
 * their native layout; later user actions can still maximize this panel normally.
 */
function codexSidePatchRevealSplit(scope, controller, hostId, revealAndFocus) {
  if (hostId !== "local" || controller.panelId !== "right" || !revealAndFocus) return;
  const panels = n("ZU27");
  const signals = n("QcW8");
  if (scope.get(signals.hy) !== "split" || scope.get(signals.em)) {
    panels.zs(scope, false, { notifyTab: false });
  }
  if (scope.get(signals.A6)) {
    panels.X8(scope, false, { notifyTab: false });
  }
}

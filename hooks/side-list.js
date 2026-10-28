/** Replace only the native Side chats section, preserving its list and summary components. */
function oe({ sideChats, onOpen, scope }) {
  const React = __sideReactFactory();
  const [selected, setSelected] = React.useState(null);
  React.useEffect(() => __sideRegisterDeleteScope(scope), [scope]);
  if (sideChats.length === 0 && selected == null) return null;
  return Q.jsxs(Q.Fragment, { children: [
    Q.jsx(M.Section, {
      sectionKey: `side-chats`,
      title: Q.jsx(o, {
        id: `codex.localConversation.sideChats.title`, defaultMessage: `Side chats`,
        description: `Title for the side chats section in the chat summary side panel`,
      }),
      titleSuffix: Q.jsx(M.SectionCount, { count: sideChats.length }),
      children: Q.jsx(se, { sideChats, onOpen, onDelete: setSelected }),
    }),
    selected == null ? null : Q.jsx(__codexSideDeleteDialog, {
      scope, row: selected, onClose: () => setSelected(null),
    }),
  ] });
}

/** Separate sibling buttons keep opening a chat independent of its destructive action menu. */
function se({ sideChats, onOpen, onDelete }) {
  return Q.jsx(M.List, {
    items: sideChats, getKey: ce,
    children: (row) => Q.jsxs(`div`, {
      className: `flex min-w-0 items-center gap-1`,
      children: [
        Q.jsxs(M.ItemButton, {
          className: `min-w-0 flex-1`, disabled: row.deletion != null,
          "aria-busy": row.deletion != null || row.isResponseInProgress,
          onClick: () => { if (!row.deletion) onOpen(row); },
          children: [
            Q.jsx(M.ItemLeading, {
              children: row.deletion || row.isResponseInProgress ? Q.jsx(s, {}) : Q.jsx(C, {}),
            }),
            Q.jsx(M.ItemLabel, {
              children: row.deletion ? `${row.title} · 删除中` : row.title,
            }),
          ],
        }),
        row.durable == null ? null : Q.jsx(__codexSideChatMenu, { row, onDelete }),
      ],
    }),
  });
}

/**
 * Native menus portal outside the summary's clipping and scroll containers in both pinned and
 * floating layouts. Keep the trigger beside the open-chat button and let the native component
 * handle positioning, keyboard navigation, outside dismissal and focus restoration.
 */
function __codexSideChatMenu({ row, onDelete }) {
  const React = __sideReactFactory();
  /** Suppress only the menu-to-dialog focus restore so the confirmation's cancel button keeps focus. */
  const openingConfirmation = React.useRef(false);
  __sideInitMenu();
  return Q.jsx(__sideMenu, {
    align: `end`, side: `bottom`, sideOffset: 4,
    triggerButton: Q.jsx(`button`, {
      type: `button`,
      className: `no-drag shrink-0 cursor-pointer rounded px-2 py-1 hover:bg-token-surface-secondary`,
      "aria-label": `${row.title}的操作`, children: `⋯`,
    }),
    onCloseAutoFocus: (event) => {
      if (!openingConfirmation.current) return;
      openingConfirmation.current = false;
      event.preventDefault();
    },
    children: Q.jsx(__sideMenuItem, {
      tone: `destructive`,
      onSelect: () => {
        openingConfirmation.current = true;
        onDelete(row);
      },
      children: row.deletion ? `重试永久删除` : `永久删除`,
    }),
  });
}

/** Use Codex's native modal and destructive buttons; cancellation is the default focus target. */
function __codexSideDeleteDialog({ scope, row, onClose }) {
  const React = __sideReactFactory();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const submitting = React.useRef(false);
  /** The ref closes the same-frame duplicate-submit window before React renders its busy state. */
  const submit = async (event) => {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError(null);
    try {
      await __sideDelete(scope, row.durable);
      onClose();
      scope.get(__sideToasts).info(`侧边聊天已永久删除`);
    } catch (caught) {
      submitting.current = false; setBusy(false);
      setError(caught?.message ?? String(caught));
    }
  };
  __sideInitButton(); __sideInitDialog(); __sideInitLayout();
  __sideInitSlot(); __sideInitText(); __sideInitContainer();
  return Q.jsx(__sideDialog, {
    open: true, size: `compact`,
    onOpenChange: (open) => { if (!open && !submitting.current) onClose(); },
    children: Q.jsxs(__sideDialogForm, {
      as: `form`, className: `select-none`, onSubmit: submit,
      children: [
        Q.jsx(__sideDialogSection, {
          children: Q.jsx(__sideDialogHeader, {
            title: Q.jsx(__sideDialogTitle, { children: `永久删除“${row.title}”？` }),
            subtitle: Q.jsx(__sideDialogDescription, {
              children: `此侧边聊天及其子代理聊天将永久删除，无法撤销；正在进行的回复也会停止。`,
            }),
          }),
        }),
        error == null ? null : Q.jsx(`p`, {
          role: `alert`, className: `px-4 text-sm text-token-text-error`, children: error,
        }),
        Q.jsx(__sideDialogSection, {
          children: Q.jsxs(__sideDialogActions, { children: [
            Q.jsx(__sideButton, {
              type: `button`, autoFocus: true, color: `outline`, disabled: busy,
              onClick: onClose, children: `取消`,
            }),
            Q.jsx(__sideButton, {
              type: `submit`, color: `danger`, loading: busy, disabled: busy, children: `永久删除`,
            }),
          ] }),
        }),
      ],
    }),
  });
}

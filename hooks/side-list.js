const __sideReact = n("zd8w");
const __sideMenuItems = n("I0j2");
const __sideButton = n("ygO2");
const __sideDialog = n("JNtf");
const __sideDialogLayout = n("mUDD");
const __sideToasts = n("SGsN");
const r = n("ABep"), a = n("oyxz"), l = n("Wf1j"), i = n("rmk3");
const o = n("Ynxh"), c = n("j89V"), u = n("lBcl");

/** Extend build 25894's native list only for compatibility-registry rows. */
function d(e) {
  const { sideChats, onOpen, error } = e;
  const [selected, setSelected] = __sideReact.useState(null);
  const scope = (0, n("zTeN").gh)(n("Oj9r").GD);
  __sideReact.useEffect(
    () => n("V7mA").codexSidePatchRegisterDeletionScope(scope),
    [scope],
  );
  if (sideChats.length === 0 && selected == null && error == null) return null;
  return r.jsxs(r.Fragment, {
    children: [
      r.jsxs(u.x.Section, {
        sectionKey: "side-chats",
        title: r.jsx(a.A, {
          id: "codex.localConversation.sideChats.title",
          defaultMessage: "Side chats",
          description: "Title for the side chats section in the chat summary side panel",
        }),
        titleSuffix: r.jsx(u.x.SectionCount, { count: sideChats.length }),
        children: [
          error,
          r.jsx(m, { sideChats, onOpen, onDelete: setSelected }),
        ],
      }),
      selected == null ? null : r.jsx(__codexSideDeleteDialog, {
        scope,
        row: selected,
        onClose: () => setSelected(null),
      }),
    ],
  });
}

/** Keep native row rendering and context menus; add one verified destructive action when needed. */
function m(e) {
  const { sideChats, onOpen, onDelete } = e;
  const intl = (0, l.A)();
  return r.jsx(u.x.List, {
    items: sideChats,
    getKey: h,
    children: (row) => {
      const button = r.jsxs(u.x.ItemButton, {
        "aria-busy": row.deletion != null || row.isResponseInProgress,
        "aria-label": row.title,
        "aria-description": row.hasUnreadTurn ? intl.formatMessage({
          id: "sidebar.navItem.unread",
          defaultMessage: "Unread updates",
          description: "Accessible description for a navigation item with unread updates",
        }) : void 0,
        disabled: row.deletion != null,
        onClick: () => {
          if (row.deletion == null) onOpen(row);
        },
        children: [
          r.jsx(u.x.ItemLeading, { children: r.jsx(o.A, {}) }),
          r.jsx(u.x.ItemLabel, {
            children: row.deletion == null ? row.title : `${row.title} · 删除中`,
          }),
          r.jsx(u.x.ItemMeta, {
            variant: "section-status",
            children: r.jsx(c.N, {
              statusState: {
                type: row.deletion != null || row.isResponseInProgress ? "loading" : "idle",
                unread: row.hasUnreadTurn,
              },
            }),
          }),
        ],
      });
      let getItems = row.getMenuItems;
      if (row.durable != null) {
        getItems = () => [
          (0, __sideMenuItems.dk)(void 0, {
            id: "delete-thread",
            tone: "destructive",
            selectAfterClose: true,
            onSelect: () => onDelete(row),
          }),
        ];
      }
      return getItems == null ? button : r.jsx(i.t, { getItems, children: button });
    },
  });
}

/** Preserve the native stable tab key for open and saved-closed rows. */
function h(row) {
  return row.tabId;
}

/** Use Codex's native compact dialog and destructive button for explicit confirmation. */
function __codexSideDeleteDialog({ scope, row, onClose }) {
  const [busy, setBusy] = __sideReact.useState(false);
  const [error, setError] = __sideReact.useState(null);
  const submitting = __sideReact.useRef(false);
  const submit = async (event) => {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await n("V7mA").codexSidePatchDelete(scope, row.durable);
      onClose();
      scope.get(__sideToasts.Id).info("侧边聊天已永久删除");
    } catch (caught) {
      submitting.current = false;
      setBusy(false);
      setError(caught?.message ?? String(caught));
    }
  };
  return r.jsx(__sideDialog.lG, {
    open: true,
    size: "compact",
    onOpenChange: (open) => {
      if (!open && !submitting.current) onClose();
    },
    children: r.jsxs(__sideDialogLayout.R4, {
      as: "form",
      className: "select-none",
      onSubmit: submit,
      children: [
        r.jsx(__sideDialogLayout.OO, {
          children: r.jsx(__sideDialogLayout.c7, {
            title: `永久删除“${row.title}”？`,
            subtitle: "此侧边聊天及其子代理聊天将永久删除，无法撤销；正在进行的回复也会停止。",
          }),
        }),
        error == null ? null : r.jsx("p", {
          role: "alert",
          className: "px-4 text-sm text-token-text-error",
          children: error,
        }),
        r.jsx(__sideDialogLayout.OO, {
          children: r.jsxs(__sideDialogLayout.Es, {
            children: [
              r.jsx(__sideButton.$, {
                type: "button",
                autoFocus: true,
                color: "secondary",
                disabled: busy,
                onClick: onClose,
                children: "取消",
              }),
              r.jsx(__sideButton.$, {
                type: "submit",
                color: "danger",
                loading: busy,
                disabled: busy,
                children: "永久删除",
              }),
            ],
          }),
        }),
      ],
    }),
  });
}

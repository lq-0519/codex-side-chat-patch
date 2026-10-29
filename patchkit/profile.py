"""Exact build adapter; no global ephemeral substitution or bundled vendor source copies."""

from pathlib import Path

from .archive import read_file, sha256_bytes


# PROFILE pins the app, engine and complete original archive inspected for this adapter.
PROFILE = {
    "id": "codex-22391-native-side-v1",
    "bundle_id": "com.openai.codex",
    "version": "26.1023.50603",
    "build": "22391",
    "cli_version": "0.165.0-alpha.1.2",
    "asar_sha256": "94a7fac7fdf222261170204df0406249822431cf4db3627d5524b6ba033ce3e6",
}
# ASSETS are the exact target bytes. Matching the version alone is never sufficient.
ASSETS = {
    "local-conversation-side-chat-9dccfe3d831a.js":
        "5baf0dfdb17b74cb59cb759f90198a65f5509de2c72c9951c6ccb345995c0796",
    "app-initial-b539f0af92f3.js":
        "96d8d335e8bd4612da5f0f370c6fc2bdee5fccdbbc269d6d6db7ae899e2aa81f",
    "persistent-92b2f845e583.js":
        "832c675c89f7fb20be86dfa4dfc7362182043deb135b2bdd4b857079b0b768da",
    "local-conversation-thread-de0d137b0115.js":
        "c7a3d8edbbb1a798158fd8e5b9a1a90bdaffeb254bee13079f4464fe400f7282",
    "local-conversation-side-chats-1ec346afe66e.js":
        "e0f714f00012b2641d2da749bcf457f1b74f1e7ebfae0c28c15e9b0f18462409",
    "composer-content-a67d714976c0.js":
        "36e485cd8e6c2bf90537492647afa49afbe0f8b26de9b14268fbe8abb88fa25f",
    # The existing menu and shortcut share this atom with the native creation admission check.
    "availability-507290cf747b.js":
        "2423f4e080d8cebc127f7268ec09d657352a2e4fd7bbe06821b65c95ad42efdb",
}
# MAIN_ASSETS independently pins native main-process storage coordination for deletion.
MAIN_ASSETS = {
    ".vite/build/main-UOTY8NmV.js":
        "ad73b094efd3d5037bceb90b285cb20d6319c4043d3b7f52ee7fade6e3015c7a",
}
# ROOT locates tracked templates only; all extraction and validation output stays outside Git.
ROOT = Path(__file__).resolve().parents[1]
# RUNTIME_PATH is a new relative ESM module in the existing ASAR asset directory.
RUNTIME_PATH = "webview/assets/codex-native-side-patch-v1.mjs"
# IMPORT shares stateless helpers without introducing a dependency on application initialization.
IMPORT = 'import*as __scp from"./codex-native-side-patch-v1.mjs";\n'
# SIDE_IMPORT exposes native identity atoms and persistent storage, preserving account boundaries.
SIDE_IMPORT = (
    'import{Lnr as __sideAccount,utr as __sideUser,oer as __sideIntl,'
    'codexSidePatchStorage as __sideStorage,'
    'codexSidePatchRegisterDeletionTab as __sideRegisterDeleteTab,'
    'codexSidePatchRegistryAtom as __sideRegistryAtom}'
    'from"./app-initial-b539f0af92f3.js";\n'
)
# UI_ASSETS pins unchanged UI exports, Portal behavior and existing side-chat entry/shortcut wiring.
UI_ASSETS = {
    "app-shared-2864d2ff2296.js":
        "f15485482923dd016959091f70166c9f0146d6a4f9d5474cd0b8be6c22603dae",
    # The launcher passes the shared availability atom through to its side-chat action.
    "thread-panel-launcher-artifacts-e43ff65356bc.js":
        "9c5cecd6a4f96775de000e7e4805e502d39063b3fa8f088d57c5b989008bd935",
    # The original shortcut is enabled only while that launcher contains the side-chat action.
    "thread-side-panel-new-tab-2a896983c7bf.js":
        "e802b8bf3a94c29f10521b979ed689fdd7396295d5e8706459b2d10c3269b406",
}


def replace_once(text, old, new):
    """Reject missing/ambiguous anchors rather than guessing how an unknown bundle works."""
    if text.count(old) != 1:
        raise ValueError("Non-unique patch anchor: " + repr(old[:160]))
    return text.replace(old, new, 1)


def replace_between(text, beginning, following, replacement):
    """Replace one complete known function using two unique neighboring declarations."""
    if text.count(beginning) != 1 or text.count(following) != 1:
        raise ValueError("Function boundary is not unique")
    start = text.index(beginning)
    end = text.index(following, start)
    return text[:start] + replacement + "\n" + text[end:]


def build_replacements(archive):
    """Construct deterministic, scoped patches from exact original packaged asset hashes."""
    for name, digest in UI_ASSETS.items():
        if sha256_bytes(read_file(archive, "webview/assets/" + name)) != digest:
            raise ValueError("Unknown native UI asset: " + name)
    source = {}
    for name, digest in ASSETS.items():
        original = read_file(archive, "webview/assets/" + name)
        if sha256_bytes(original) != digest:
            raise ValueError("Unknown original asset: " + name)
        source[name] = original.decode("utf-8")

    name = "availability-507290cf747b.js"
    # Kw (exported as VJn) resolves the source conversation's actual manager host. Check it
    # reactively rather than trusting the scope's optional hostId or the globally selected host.
    # Only a local-thread on the local manager gains the ChatGPT-mode exception; cloud/remote
    # paths retain their original gate, and the native surface, account and archive checks remain.
    text = replace_once(
        source[name],
        "O1n as o,Par as s,vGt as c",
        "O1n as o,Par as s,VJn as __sideHost,vGt as c,zJn as __sideInitHost",
    )
    # Initialize the exported host atom through its original idempotent module initializer.
    # Availability may be imported before the thread/launcher modules initialize that binding.
    text = replace_once(text, "a(),c(),d=n(l,", "a(),c(),__sideInitHost(),d=n(l,")
    source[name] = (
        "/** Reuse native side-chat menus and shortcuts for local threads in ChatGPT mode. */\n"
        + replace_once(
            text,
            "({get:e})=>e(u)&&(!e(r)||e(s,`2402779155`))",
            "({get:e,scope:t})=>e(u)&&(!e(r)||e(s,`2402779155`)||"
            "(t.value.routeKind===`local-thread`&&"
            "e(__sideHost,t.value.conversationId)===`local`))",
        )
    )

    name = "local-conversation-side-chat-9dccfe3d831a.js"
    text = replace_between(
        source[name], "async function Ut(", "function Wt(",
        (ROOT / "hooks/local-create.js").read_text(),
    )
    # A local native fork must be cancelled if its original loading tab has been retired.
    text = replace_once(
        text,
        "instructionOverrides:ct(e.get(xe),e.get(pt,i)??l?.settings.model??null),parentNavigationPath:",
        "assertRequestCurrent:()=>{if(!O.isCurrent())throw Error(`Side chat creation cancelled`);},"
        "naming:{phase:d==null?`placeholder`:`content`,baseTitle:d??Wt(f,C)},"
        "instructionOverrides:ct(e.get(xe),e.get(pt,i)??l?.settings.model??null),parentNavigationPath:",
    )
    # Cancellation archives the actual saved thread and then removes only the provisional relation.
    text = replace_once(
        text,
        "x??await L(e,t.hostId).archiveConversation(t.conversationId,"
        "{useAppServerPins:!1,source:`side-chat-cancelled`});return",
        "if(x==null){"
        "const p={conversationId:t.conversationId,options:"
        "{useAppServerPins:!1,source:`side-chat-cancelled`}};"
        "await __scp.loggedRpc(`archiveConversation`,p,()=>"
        "L(e,t.hostId).archiveConversation(t.conversationId,p.options));"
        "if(t.hostId===`local`)await __scp.forgetCancelled(__sideStorage(),t.conversationId);}"
        "return",
    )
    # Recheck after creation/resume and after caller preparation before completing a native panel.
    identity_check = (
        "__scp.assertUsable(__sideStorage(),A.durable,e.get(__sideAccount),e.get(__sideUser))"
    )
    text = replace_once(
        text,
        "if(!O.isCurrent())return await k(A),null;",
        "if(!O.isCurrent())return await k(A),null;" + identity_check + ";"
        "if(A.durable?.hostId===`local`)w=A.durable.title??w;",
    )
    text = replace_once(
        text,
        "if(j==null&&g!=null&&await g(t),!O.isCurrent())",
        "if(j==null&&g!=null&&await g(t)," + identity_check + ",!O.isCurrent())",
    )
    # N is synchronous: persist its final title at the preceding async boundary before complete().
    text = replace_once(
        text,
        "let{conversationId:o,hostId:c}=r;T!=null",
        "let{conversationId:o,hostId:c}=r;"
        "__scp.assertUsable(__sideStorage(),r.durable,e.get(__sideAccount),e.get(__sideUser));T!=null",
    )
    text = replace_once(
        text, "if(N(A)||(O.fail(v),await k(A))",
        "if(A.durable?.hostId===`local`){"
        "A.durable=await __scp.remember(__sideStorage(),{...A.durable,title:w});"
        "w=A.durable.title??w;}"
        "if(!O.isCurrent())return await k(A),null;"
        + identity_check + ";if(N(A)||(O.fail(v),await k(A))",
    )
    # Normal close already avoids native deletion for durable threads. Preserve its discovery row.
    text = replace_once(
        text,
        "(r.durable==null||ze(e,g)==null)&&(m?.(),st(e,i,o),p?.(!0))",
        "(r.durable==null||ze(e,g)==null)&&("
        "r.durable?.hostId===`local`&&Promise.resolve(__scp.hide(__sideStorage(),o))"
        ".catch(error=>console.error(__scp.errorJSON(error))),"
        "m?.(),st(e,i,o),p?.(!0))",
    )
    text = replace_once(
        text,
        "let y=()=>{if(r.durable!=null)return;let t=e.get(S.tabById$,g)?.contentInstance;",
        "let y=()=>{if(r.durable?.hostId===`local`)"
        "return __sideRegisterDeleteTab(e,r.durable);"
        "if(r.durable!=null)return;let t=e.get(S.tabById$,g)?.contentInstance;",
    )
    # A normal close that was already awaiting voice shutdown must not rebuild a deleted tab.
    text = replace_once(
        text,
        "onClose:()=>{d?.();let t=()=>{S.openTab(e,Q,",
        "onClose:()=>{d?.();let t=()=>{"
        "if(r.durable?.hostId===`local`){try{"
        "__scp.assertUsable(__sideStorage(),r.durable,e.get(__sideAccount),e.get(__sideUser));"
        "}catch{return;}}S.openTab(e,Q,",
    )
    source[name] = IMPORT + SIDE_IMPORT + text

    name = "composer-content-a67d714976c0.js"
    text = source[name]
    # Only the two side-composer naming guards change; the shared canonical counter stays intact.
    for conversation in ["r.localConversationId", "c.localConversationId"]:
        text = replace_once(
            text, f"(e.get(Nm,{conversation})??0)===0",
            f"__sideIsFirstTurn(e,{conversation})",
        )
    text = replace_once(
        text,
        "function GI(e,t,n){n!=null&&H_.updateTab(e,`sidechat:${t}`,{title:n})}",
        "function GI(e,t,n){"
        "if(__scp.isSavedSide(__sideStorage(),`local`,t))"
        "__sideNameFirstTurn(e,t,n).catch(error=>console.error(__scp.errorJSON(error)));"
        "else n!=null&&H_.updateTab(e,`sidechat:${t}`,{title:n})}",
    )
    source[name] = IMPORT + (
        'import{codexSidePatchStorage as __sideStorage,'
        'codexSidePatchIsFirstTurn as __sideIsFirstTurn,'
        'codexSidePatchNameFirstTurn as __sideNameFirstTurn}'
        'from"./app-initial-b539f0af92f3.js";\n'
    ) + text

    name = "persistent-92b2f845e583.js"
    source[name] = IMPORT + SIDE_IMPORT + replace_between(
        source[name], "async function H(", "function U(",
        (ROOT / "hooks/restore.js").read_text(),
    )

    name = "app-initial-b539f0af92f3.js"
    text = source[name]
    # iE is the frontend presentation merge; native server history and rE remain unmodified.
    text = replace_once(
        text,
        "function iE(e,t){let n=rE(e);return e.turnHistory?.kind===`canonical`?"
        "nl(n,e.turns,{policy:t}):n}",
        "function iE(e,t){let n=rE(e);return __scp.displayTurns(codexSidePatchStorage(),e,"
        "e.turnHistory?.kind===`canonical`?nl(n,e.turns,{policy:t}):n)}",
    )
    # Unified timeline selectors read canonical entities directly and bypass iE.
    text = replace_once(
        text,
        "return Y9a({conversationRequests:a,isAeonThread:o,",
        "return Y9a(__scp.presentationOptions(codexSidePatchStorage(),"
        "{id:e,hostId:l.hostId},{conversationRequests:a,isAeonThread:o,",
    )
    text = replace_once(
        text,
        "turnEntityKeys:m?.map(({entityKey:e})=>e)})",
        "turnEntityKeys:m?.map(({entityKey:e})=>e)}))",
    )
    text = replace_once(
        text,
        "shouldSurfaceRecentConversation(e){return!this.isConversationSuppressed(e.id)",
        "shouldSurfaceRecentConversation(e){return"
        "!__scp.isSavedSide(codexSidePatchStorage(),this.params.hostId,e.id)"
        "&&!this.isConversationSuppressed(e.id)",
    )
    text = replace_once(
        text,
        "shouldSurfaceThreadSummary(e){return!this.isConversationSuppressed(e.conversationId)",
        "shouldSurfaceThreadSummary(e){return"
        "!__scp.isSavedSide(codexSidePatchStorage(),this.params.hostId,e.conversationId)"
        "&&!this.isConversationSuppressed(e.conversationId)",
    )
    # Log actual native fork and boundary RPC envelopes only for newly modified local side forks.
    text = replace_once(
        text,
        "let _=await o.sendRequest(`thread/fork`,n,f),v=Jn(_.thread.id)",
        "let _=await(c.sideConversation&&r===`default`?"
        "__scp.loggedRpc(`thread/fork`,n,()=>o.sendRequest(`thread/fork`,n,f)):"
        "o.sendRequest(`thread/fork`,n,f)),v=Jn(_.thread.id)",
    )
    # Native manager request admission blocks late sends/restores once the deletion claim exists.
    text = replace_once(
        text,
        "async sendRequest(e,t,n){this.assertActive();"
        "let r=await this.requestClient.sendRequest(e,t,n);",
        "async sendRequest(e,t,n){this.assertActive();"
        "__scp.guardSideRequest(codexSidePatchStorage(),this.hostId,e,t);"
        "let r=await this.requestClient.sendRequest(e,t,n);",
    )
    text = replace_once(
        text,
        "sendFollowUpMessage(e,t){return Oon(",
        "sendFollowUpMessage(e,t){"
        "__scp.guardSideRequest(codexSidePatchStorage(),this.hostId,`turn/start`,{threadId:e});"
        "return Oon(",
    )
    text = replace_once(
        text,
        "sendThreadFollowerRequest(e,t,n,r){if(this.assertActive(),",
        "sendThreadFollowerRequest(e,t,n,r){"
        "__scp.guardSideRequest(codexSidePatchStorage(),this.hostId,t,n);"
        "if(this.assertActive(),",
    )
    text = replace_once(
        text,
        "this.streamRecovery.markAllConversationsNeedResumeAfterReconnect(e)}async ",
        "this.streamRecovery.markAllConversationsNeedResumeAfterReconnect(e),"
        "__scp.recoverDeletions(this)}async ",
    )
    text += """
/** Reuse one native KV adapter across hot selectors; reads still fetch the latest native snapshot. */
var __codexSideStorage;
/** Lazily bind existing persistent KV functions after native initialization, without new I/O. */
export function codexSidePatchStorage(){
  return __codexSideStorage??=__scp.mutationStorage({
    readValue:tv,publish:(key,value)=>Q_()(key,value),
    subscribe:(key,callback)=>iv(key,void 0,callback),
    clearReply:key=>$_(key,void 0,!1)
  });
}
/** Lazily initialized native KV atom makes saved and hidden rows reactive across windows. */
var __codexSideRegistryAtom;
/** Resolve the registry signal only after the application's signal runtime is initialized. */
export function codexSidePatchRegistryAtom(){
  return __codexSideRegistryAtom??=(uv(()=>__scp.REGISTRY_KEY,null));
}
"""
    text += (ROOT / "hooks/delete-adapter.js").read_text()
    text += (ROOT / "hooks/title-adapter.js").read_text()
    source[name] = IMPORT + text

    name = "local-conversation-thread-de0d137b0115.js"
    text = source[name]
    # Reuse the original summary section instead of creating an independent recovery UI.
    text = replace_once(
        text,
        "kO=wn(hp,({get:e})=>CO(e(Ju.tabs$),t=>e(za,t)??!1))",
        "kO=wn(hp," + (ROOT / "hooks/summary.js").read_text().strip() + ")",
    )
    text = replace_once(
        text,
        "r=e=>{co(t,`right`,e.tabId)}",
        "r=e=>{if(e.deletion)return;if(e.isSavedClosed&&e.durable){"
        "hg(t,WF,{durable:e.durable,sourceConversationId:e.durable.sourceConversationId,"
        "hostId:e.durable.hostId,cwd:null,collaborationMode:e.durable.collaborationMode,"
        "displayTitle:e.title,intl:t.get(__sideIntl),target:`right`})"
        ".catch(error=>t.get(Fe).danger(error.message));"
        "}else co(t,`right`,e.tabId)}",
    )
    text = replace_once(
        text, "(Fv,{sideChats:n,onOpen:r})", "(Fv,{sideChats:n,onOpen:r,scope:t})",
    )
    # Runtime text depends on the actual registered thread, so unchanged temporary hosts stay truthful.
    text = replace_once(
        text,
        "id:`localConversation.sideChat.empty.description`,defaultMessage:"
        "`Side chats are temporary and disappear when you close the app.`,description:"
        "`Explains that ephemeral side chats disappear when the app is closed`",
        "id:__scp.isSavedSide(__sideStorage(),r,t)?"
        "`codexSidePatch.saved.empty.description`:`localConversation.sideChat.empty.description`,"
        "defaultMessage:__scp.isSavedSide(__sideStorage(),r,t)?"
        "`This side chat is saved. Reopen it from Side chats in the parent chat after closing the app.`:"
        "`Side chats are temporary and disappear when you close the app.`,"
        "description:`Explains the lifetime of this side chat`",
    )
    source[name] = IMPORT + SIDE_IMPORT + text

    name = "local-conversation-side-chats-1ec346afe66e.js"
    text = replace_between(
        source[name], "function oe(", "function ce(",
        (ROOT / "hooks/side-list.js").read_text(),
    )
    # Native menus portal outside summary clipping; pin their exports and lazy initialization.
    text = (
        'import{OHt as __sideReactFactory,K6 as __sideInitButton,$N as __sideInitDialog,'
        'pP as __sideInitMenu,oP as __sideMenu,dP as __sideMenuItem,'
        'qN as __sideInitLayout,wX as __sideInitSlot,Wit as __sideInitText,'
        'dct as __sideInitContainer,YN as __sideDialog,VN as __sideDialogForm,'
        'WN as __sideDialogSection,UN as __sideDialogHeader,QN as __sideDialogTitle,'
        'ZN as __sideDialogDescription,HN as __sideDialogActions,W6 as __sideButton,'
        'Jit as __sideToasts}from"./app-shared-2864d2ff2296.js";\n'
        'import{codexSidePatchDelete as __sideDelete,'
        'codexSidePatchRegisterDeletionScope as __sideRegisterDeleteScope}'
        'from"./app-initial-b539f0af92f3.js";\n'
    ) + text
    source[name] = text
    result = {"webview/assets/" + name: value.encode() for name, value in source.items()}
    result[RUNTIME_PATH] = (ROOT / "runtime/persistence.mjs").read_bytes()
    for name, digest in MAIN_ASSETS.items():
        original = read_file(archive, name)
        if sha256_bytes(original) != digest:
            raise ValueError("Unknown original main-process asset: " + name)
        text = replace_once(
            original.decode(), "updatePersistedAtomState(e,t,n,r){",
            "updatePersistedAtomState(e,t,n,r){"
            "let __sideState=__codexSideState.handle(this,e,t,n);"
            "if(__sideState.handled)return;n=__sideState.value;",
        )
        result[name] = (
            'const __codexSideState=require("./codex-native-side-state-v1.cjs");\n' + text
        ).encode()
    result[".vite/build/codex-native-side-state-v1.cjs"] = (ROOT / "runtime/main-state.cjs").read_bytes()
    return result


def implementation_digest():
    """Pin templates, adapter and signing policy so a stale or unlaunchable package gets rebuilt."""
    files = [
        ROOT / "patchkit/profile.py", ROOT / "runtime/persistence.mjs",
        ROOT / "hooks/local-create.js", ROOT / "hooks/restore.js", ROOT / "hooks/summary.js",
        ROOT / "hooks/delete-adapter.js", ROOT / "hooks/side-list.js", ROOT / "runtime/main-state.cjs",
        ROOT / "hooks/title-adapter.js",
        ROOT / "patchkit/manager.py", ROOT / "patchkit/integrity.py",
    ]
    return sha256_bytes(b"".join(path.read_bytes() for path in files))

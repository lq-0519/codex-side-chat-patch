"""Exact build adapter; no global ephemeral substitution or bundled vendor source copies."""

from pathlib import Path

from .archive import read_file, sha256_bytes


# PROFILE pins the app, engine and complete original archive inspected for this adapter.
PROFILE = {
    "id": "codex-24141-native-side-v1",
    "bundle_id": "com.openai.codex",
    "version": "26.1027.61615",
    "build": "24141",
    "cli_version": "0.166.0-alpha.5.1",
    "asar_sha256": "bb88615052255e79b5977885f9a0cc212c268589587c79d4d3b7c4b46e881a95",
}
# ASSETS are the exact target bytes. Matching the version alone is never sufficient.
ASSETS = {
    "local-conversation-side-chat-4d7fc512f796.js":
        "a732b0c57fb9360c1901ec9c1e27c9a8f284bdd93b244ddaf8d6deddb2960ff1",
    "app-initial-18b189e867e7.js":
        "244653d55e434b27618a848bef14d6d6781569bf58e8656cf644445113ffc032",
    "persistent-171a29907c0a.js":
        "de6ce52f288d02f6a8e5bd2e89b51ebfc4435673467708483eb6c43079370dce",
    "local-conversation-thread-2f594f841b07.js":
        "af8e8ab2e97566d25d69249ef8adf5a86d0bf0bbf4c306e4fbc50c80e8837263",
    "local-conversation-side-chats-9a3e815461eb.js":
        "5448c533e15f1cb8bc4caed480ea80a05558628c2891fc5abcb7c9c6b7af7a43",
    "composer-content-b926d24ef280.js":
        "cf56f37714e14488239f4eb715b845067e75f8c2e98851c768c4110d3eb6fd08",
    # First-turn title updates moved out of the composer into this native shared callback.
    "app-primary-75d53eef2374.js":
        "ebaecd54561e7e3da76c08b0d900e056424d57b1b23675afad4d7d235599f80b",
    # The existing menu and shortcut share this atom with the native creation admission check.
    "availability-e24a65467b89.js":
        "e4e7360dd1614ef2acec5a6f3b786e13e29063873d3a1a4653d995314bc0c434",
}
# MAIN_ASSETS independently pins native main-process storage coordination for deletion.
MAIN_ASSETS = {
    ".vite/build/early-bootstrap-439-a0f25ba32c465de1.js":
        "c23f63f8ff156b2a92a81ee2870d80ab959ced6ce6232d6fe7e54bbefe11d333",
}
# ROOT locates tracked templates only; all extraction and validation output stays outside Git.
ROOT = Path(__file__).resolve().parents[1]
# RUNTIME_PATH is a new relative ESM module in the existing ASAR asset directory.
RUNTIME_PATH = "webview/assets/codex-native-side-patch-v1.mjs"
# IMPORT shares stateless helpers without introducing a dependency on application initialization.
IMPORT = 'import*as __scp from"./codex-native-side-patch-v1.mjs";\n'
# SIDE_IMPORT exposes native identity atoms and persistent storage, preserving account boundaries.
SIDE_IMPORT = (
    'import{Klr as __sideAccount,ycr as __sideUser,psr as __sideIntl,'
    'codexSidePatchStorage as __sideStorage,'
    'codexSidePatchRegisterDeletionTab as __sideRegisterDeleteTab,'
    'codexSidePatchRegistryAtom as __sideRegistryAtom}'
    'from"./app-initial-18b189e867e7.js";\n'
)
# UI_ASSETS pins unchanged UI exports, Portal behavior and existing side-chat entry/shortcut wiring.
UI_ASSETS = {
    "app-shared-601019a330d7.js":
        "02dd01d1e7c076ec44f10bb8446976f07be9eb007d1c32445adf5cda13221116",
    # The launcher passes the shared availability atom through to its side-chat action.
    "thread-panel-launcher-artifacts-17e648b1a79d.js":
        "0a2da3ede51bfb82183771b6b39f176d5adead539434127692d6a6ecf0c2b0c0",
    # The original shortcut is enabled only while that launcher contains the side-chat action.
    "thread-side-panel-new-tab-c74d1915bdc1.js":
        "1fe10d5b1ce3caabeb3d177484073674e155cd2cb1c05bdf3a65eedf1bd5b0de",
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

    name = "availability-e24a65467b89.js"
    # BS (exported as f3n) resolves the source conversation's actual manager host. Check it
    # reactively rather than trusting the scope's optional hostId or the globally selected host.
    # Only a local-thread on the local manager gains the ChatGPT-mode exception; cloud/remote
    # paths retain their original gate, and the native surface, account and archive checks remain.
    text = replace_once(
        source[name],
        "e2t as o,jer as s,p5n as c",
        "e2t as o,jer as s,p5n as c,f3n as __sideHost,"
        "u3n as __sideInitHost",
    )
    # Initialize the exported host atom through its original idempotent module initializer.
    # Availability may be imported before the thread/launcher modules initialize that binding.
    text = replace_once(text, "u(),o(),d=t(c,", "u(),o(),__sideInitHost(),d=t(c,")
    source[name] = (
        "/** Reuse native side-chat menus and shortcuts for local threads in ChatGPT mode. */\n"
        + replace_once(
            text,
            "({get:e})=>e(l)&&(!e(s)||e(i,`2402779155`))",
            "({get:e,scope:t})=>e(l)&&(!e(s)||e(i,`2402779155`)||"
            "(t.value.routeKind===`local-thread`&&"
            "e(__sideHost,t.value.conversationId)===`local`))",
        )
    )

    name = "local-conversation-side-chat-4d7fc512f796.js"
    text = replace_between(
        source[name], "async function an(", "function on(",
        (ROOT / "hooks/local-create.js").read_text(),
    )
    # A local native fork must be cancelled if its original loading tab has been retired.
    text = replace_once(
        text,
        "instructionOverrides:Xe(e.get(Me),e.get(mt,i)??c?.settings.model??null),parentNavigationPath:",
        "assertRequestCurrent:()=>{if(!k.isCurrent())throw Error(`Side chat creation cancelled`);},"
        "naming:{phase:u==null?`placeholder`:`content`,baseTitle:u??on(d,w)},"
        "instructionOverrides:Xe(e.get(Me),e.get(mt,i)??c?.settings.model??null),parentNavigationPath:",
    )
    # Cancellation archives the actual saved thread and then removes only the provisional relation.
    text = replace_once(
        text,
        "y??await U(e,t.hostId).archiveConversation(t.conversationId,"
        "{useAppServerPins:!1,source:`side-chat-cancelled`});return",
        "if(y==null){"
        "const p={conversationId:t.conversationId,options:"
        "{useAppServerPins:!1,source:`side-chat-cancelled`}};"
        "await __scp.loggedRpc(`archiveConversation`,p,()=>"
        "U(e,t.hostId).archiveConversation(t.conversationId,p.options));"
        "if(t.hostId===`local`)await __scp.forgetCancelled(__sideStorage(),t.conversationId);}"
        "return",
    )
    # Recheck after creation/resume and after caller preparation before completing a native panel.
    identity_check = (
        "__scp.assertUsable(__sideStorage(),j.durable,e.get(__sideAccount),e.get(__sideUser))"
    )
    text = replace_once(
        text,
        "if(!k.isCurrent())return await A(j),null;",
        "if(!k.isCurrent())return await A(j),null;" + identity_check + ";"
        "if(j.durable?.hostId===`local`)T=j.durable.title??T;",
    )
    text = replace_once(
        text,
        "if(M==null&&m!=null&&await m(t),!k.isCurrent())",
        "if(M==null&&m!=null&&await m(t)," + identity_check + ",!k.isCurrent())",
    )
    # ne is synchronous: persist its final title at the preceding async boundary before complete().
    text = replace_once(
        text,
        "let{conversationId:s,hostId:u}=r,m=r.durable!=null||r.persistent===!0;",
        "let{conversationId:s,hostId:u}=r,m=r.durable!=null||r.persistent===!0;"
        "__scp.assertUsable(__sideStorage(),r.durable,e.get(__sideAccount),e.get(__sideUser));",
    )
    text = replace_once(
        text, "if(ne(j)||(k.fail(_),await A(j))",
        "if(j.durable?.hostId===`local`){"
        "j.durable=await __scp.remember(__sideStorage(),{...j.durable,title:T});"
        "T=j.durable.title??T;}"
        "if(!k.isCurrent())return await A(j),null;"
        + identity_check + ";if(ne(j)||(k.fail(_),await A(j))",
    )
    # Normal close already avoids native deletion for durable threads. Preserve its discovery row.
    text = replace_once(
        text,
        "m&&ht(e,_)!=null||(p?.(),ke(e,i,s),f?.(!0))",
        "m&&ht(e,_)!=null||("
        "r.durable?.hostId===`local`&&Promise.resolve(__scp.hide(__sideStorage(),s))"
        ".catch(error=>console.error(__scp.errorJSON(error))),"
        "p?.(),ke(e,i,s),f?.(!0))",
    )
    text = replace_once(
        text,
        "let x=()=>{if(m)return;let t=e.get(C.tabById$,_)?.contentInstance;",
        "let x=()=>{if(r.durable?.hostId===`local`)"
        "return __sideRegisterDeleteTab(e,r.durable);"
        "if(m)return;let t=e.get(C.tabById$,_)?.contentInstance;",
    )
    # A normal close that was already awaiting voice shutdown must not rebuild a deleted tab.
    text = replace_once(
        text,
        "onClose:()=>{g?.();let t=()=>{C.openTab(e,$,",
        "onClose:()=>{g?.();let t=()=>{"
        "if(r.durable?.hostId===`local`){try{"
        "__scp.assertUsable(__sideStorage(),r.durable,e.get(__sideAccount),e.get(__sideUser));"
        "}catch{return;}}C.openTab(e,$,",
    )
    source[name] = IMPORT + SIDE_IMPORT + text

    name = "composer-content-b926d24ef280.js"
    text = source[name]
    # Only the two side-composer naming guards change; the shared canonical counter stays intact.
    for conversation in ["r.localConversationId", "c.localConversationId"]:
        text = replace_once(
            text, f"(e.get(yo,{conversation})??0)===0",
            f"__sideIsFirstTurn(e,{conversation})",
        )
    source[name] = (
        'import{codexSidePatchIsFirstTurn as __sideIsFirstTurn}'
        'from"./app-initial-18b189e867e7.js";\n'
    ) + text

    name = "app-primary-75d53eef2374.js"
    # olr is the native Markdown cleaner; preserve the native callback for other hosts/threads.
    text = replace_once(
        source[name],
        "function slr(e,t,n,r){e.get(VD,{hostId:t,threadId:n})??clr(e,`${xm}${n}`,olr(r))}",
        "function slr(e,t,n,r){"
        "if(__scp.isSavedSide(__sideStorage(),t,n))"
        "__sideNameFirstTurn(e,n,olr(r)).catch(error=>console.error(__scp.errorJSON(error)));"
        "else e.get(VD,{hostId:t,threadId:n})??clr(e,`${xm}${n}`,olr(r))}",
    )
    source[name] = IMPORT + (
        'import{codexSidePatchStorage as __sideStorage,'
        'codexSidePatchNameFirstTurn as __sideNameFirstTurn}'
        'from"./app-initial-18b189e867e7.js";\n'
    ) + text

    name = "persistent-171a29907c0a.js"
    source[name] = IMPORT + SIDE_IMPORT + replace_between(
        source[name], "async function H(", "function U(",
        (ROOT / "hooks/restore.js").read_text(),
    )

    name = "app-initial-18b189e867e7.js"
    text = source[name]
    # FT is the frontend presentation merge; native server history and PT remain unmodified.
    text = replace_once(
        text,
        "function FT(e,t){let n=PT(e);return e.turnHistory?.kind===`canonical`?"
        "dl(n,e.turns,{policy:t}):n}",
        "function FT(e,t){let n=PT(e);return __scp.displayTurns(codexSidePatchStorage(),e,"
        "e.turnHistory?.kind===`canonical`?dl(n,e.turns,{policy:t}):n)}",
    )
    # Unified timeline selectors read canonical entities directly and bypass FT.
    text = replace_once(
        text,
        "return aTo({conversationRequests:a,isAeonThread:o,",
        "return aTo(__scp.presentationOptions(codexSidePatchStorage(),"
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
        "let v=await o.sendRequest(`thread/fork`,n.request,f),y=ka(v.thread.id)",
        "let v=await(c.sideConversation&&r===`default`?"
        "__scp.loggedRpc(`thread/fork`,n.request,()=>o.sendRequest(`thread/fork`,n.request,f)):"
        "o.sendRequest(`thread/fork`,n.request,f)),y=ka(v.thread.id)",
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
        "sendFollowUpMessage(e,t){return Edn(",
        "sendFollowUpMessage(e,t){"
        "__scp.guardSideRequest(codexSidePatchStorage(),this.hostId,`turn/start`,{threadId:e});"
        "return Edn(",
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
        "this.streamRecovery.markAllConversationsNeedResumeAfterReconnect(e),this.readState.reset()}async ",
        "this.streamRecovery.markAllConversationsNeedResumeAfterReconnect(e),"
        "this.readState.reset(),__scp.recoverDeletions(this)}async ",
    )
    text += """
/** Reuse one native KV adapter across hot selectors; reads still fetch the latest native snapshot. */
var __codexSideStorage;
/** Lazily bind existing persistent KV functions after native initialization, without new I/O. */
export function codexSidePatchStorage(){
  return __codexSideStorage??=__scp.mutationStorage({
    readValue:N_,publish:(key,value)=>A_()(key,value),
    subscribe:(key,callback)=>I_(key,void 0,callback),
    clearReply:key=>j_(key,void 0,!1)
  });
}
/** Lazily initialized native KV atom makes saved and hidden rows reactive across windows. */
var __codexSideRegistryAtom;
/** Resolve the registry signal only after the application's signal runtime is initialized. */
export function codexSidePatchRegistryAtom(){
  return __codexSideRegistryAtom??=(H_(()=>__scp.REGISTRY_KEY,null));
}
"""
    text += (ROOT / "hooks/delete-adapter.js").read_text()
    text += (ROOT / "hooks/title-adapter.js").read_text()
    source[name] = IMPORT + text

    name = "local-conversation-thread-2f594f841b07.js"
    text = source[name]
    # Reuse the original summary section instead of creating an independent recovery UI.
    text = replace_once(
        text,
        "vk=l(Yd,({get:e})=>{",
        "vk=l(Yd,({get:e,scope:__sideScope})=>{",
    )
    text = replace_once(
        text, "return[...new Set([...r.keys(),...n.keys()])]",
        "return __codexSideSummaryRows({get:e,scope:__sideScope},"
        "[...new Set([...r.keys(),...n.keys()])]",
    )
    text = replace_once(
        text, "savedThread:o==null?null:s}})})})))()}function bk(",
        "savedThread:o==null?null:s}}))})})))()}function bk(",
    )
    text = replace_once(
        text,
        "l=e=>{let r=Fp(t,e.tabId);",
        "l=e=>{if(e.deletion)return;if(e.isSavedClosed&&e.durable){"
        "Wg(t,Xg,{durable:e.durable,sourceConversationId:e.durable.sourceConversationId,"
        "hostId:e.durable.hostId,cwd:null,collaborationMode:e.durable.collaborationMode,"
        "displayTitle:e.title,intl:t.get(__sideIntl),target:`right`})"
        ".catch(error=>t.get(tn).danger(error.message));return;}"
        "let r=Fp(t,e.tabId);",
    )
    text = replace_once(
        text, "(by,{sideChats:s,error:c,onOpen:l})",
        "(by,{sideChats:s,error:c,onOpen:l,scope:t})",
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
    source[name] = IMPORT + SIDE_IMPORT + (
        "/** Merge plugin discovery with the original native attached-chat selector. */\n"
        "const __codexSideSummaryRows="
        + (ROOT / "hooks/summary.js").read_text().strip() + ";\n"
    ) + text

    name = "local-conversation-side-chats-9a3e815461eb.js"
    text = replace_between(
        source[name], "function de(", "function X(",
        (ROOT / "hooks/side-list.js").read_text(),
    )
    # Native menus portal outside summary clipping; pin their exports and lazy initialization.
    text = (
        'import{pWt as __sideReactFactory,o5 as __sideInitButton,CP as __sideInitDialog,'
        'LP as __sideInitMenu,AP as __sideMenu,FP as __sideMenuItem,'
        '_P as __sideInitLayout,RZ as __sideInitSlot,sot as __sideInitText,'
        'Alt as __sideInitContainer,yP as __sideDialog,dP as __sideDialogForm,'
        'mP as __sideDialogSection,pP as __sideDialogHeader,SP as __sideDialogTitle,'
        'xP as __sideDialogDescription,fP as __sideDialogActions,i5 as __sideButton,'
        'dot as __sideToasts}from"./app-shared-601019a330d7.js";\n'
        'import{codexSidePatchDelete as __sideDelete,'
        'codexSidePatchRegisterDeletionScope as __sideRegisterDeleteScope}'
        'from"./app-initial-18b189e867e7.js";\n'
    ) + text
    source[name] = text
    result = {"webview/assets/" + name: value.encode() for name, value in source.items()}
    result[RUNTIME_PATH] = (ROOT / "runtime/persistence.mjs").read_bytes()
    for name, digest in MAIN_ASSETS.items():
        original = read_file(archive, name)
        if sha256_bytes(original) != digest:
            raise ValueError("Unknown original main-process asset: " + name)
        text = replace_once(
            original.decode(), "updatePersistedAtomState(e,t,r,n){",
            "updatePersistedAtomState(e,t,r,n){"
            "let __sideState=__codexSideState.handle(this,e,t,r);"
            "if(__sideState.handled)return;r=__sideState.value;",
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

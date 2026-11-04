"""Exact build adapter for Codex's Rspack side-chat modules and native persistent storage."""

from pathlib import Path

from .archive import read_file, sha256_bytes


# PROFILE pins the complete vendor archive and bundled CLI inspected for this adapter.
PROFILE = {
    "id": "codex-24614-rspack-side-v1",
    "bundle_id": "com.openai.codex",
    "version": "26.1029.61003",
    "build": "24614",
    "cli_version": "0.166.0-alpha.6",
    "asar_sha256": "0c951258b7ab381ec601045ffb02159e53f424548dda18e6a4dcfd126557383b",
}
# ASSETS pin complete Rspack chunks, not only the individual minified modules patched below.
ASSETS = {
    "async/24191.589dcc9878.js":
        "bd23d61085fcad60b8f582112d4ca0695b34204510cff900ba0f87c9c61228d0",
    "async/299250.3353e2695c.js":
        "e9a2d0385ef5bf4a6bf930327c9bcfbcf8634592a4a74d792f1477588079fb93",
    "async/357959.de4ec41383.js":
        "9ce961467bdae5b5afc3a73974235e39483cb9bad0f83ce6177a61a0f996f51d",
    "async/589850.4264f95e93.js":
        "3e01ea1eaaacea58cda43e28dd8a3170243d017e5598083d2952f70de8aeb867",
    "async/563813.7486e43f6b.js":
        "be18b9983577cfb50cac8c98725c0d554d32110d7c485950177f0481ef2f0d09",
}
# MAIN_ASSETS independently pins native main-process storage coordination for deletion.
MAIN_ASSETS = {
    ".vite/build/early-bootstrap-45-628adb74a9c47df1.js":
        "b799f597bb0be309b49eac7c4e4b972f2bb8b5dd82a4e44bede43add38568820",
}
# ROOT locates tracked templates only; extraction and validation output stays outside Git.
ROOT = Path(__file__).resolve().parents[1]
# RUNTIME_PATH remains an ordinary ESM dependency of each patched Rspack chunk.
RUNTIME_PATH = "webview/assets/codex-native-side-patch-v1.mjs"
IMPORT = 'import*as __scp from"../codex-native-side-patch-v1.mjs";\n'


def replace_once(text, old, new):
    """Reject missing or ambiguous anchors instead of guessing how an unknown bundle works."""
    if text.count(old) != 1:
        raise ValueError("Non-unique patch anchor: " + repr(old[:160]))
    return text.replace(old, new, 1)


def replace_count(text, old, new, expected):
    """Replace an exact known number of equivalent call sites in one hash-pinned chunk."""
    if text.count(old) != expected:
        raise ValueError(
            f"Expected {expected} patch anchors, found {text.count(old)}: {old[:120]!r}"
        )
    return text.replace(old, new)


def replace_between_after(text, marker, beginning, following, replacement):
    """Replace one function or region after a unique module marker."""
    if text.count(marker) != 1:
        raise ValueError("Module marker is not unique: " + repr(marker))
    module_start = text.index(marker)
    start = text.find(beginning, module_start)
    end = text.find(following, start + len(beginning))
    if start < 0 or end < 0:
        raise ValueError("Patch region is missing after module marker")
    if text.find(beginning, start + 1, end) >= 0:
        raise ValueError("Patch beginning is ambiguous inside module region")
    return text[:start] + replacement + text[end:]


def build_replacements(archive):
    """Construct deterministic scoped patches from exact original packaged chunk hashes."""
    source = {}
    for name, digest in ASSETS.items():
        original = read_file(archive, "webview/assets/" + name)
        if sha256_bytes(original) != digest:
            raise ValueError("Unknown original Rspack chunk: " + name)
        source[name] = original.decode("utf-8")

    # Core manager, storage adapter, deletion lifecycle and title adapter.
    name = "async/24191.589dcc9878.js"
    text = source[name]
    text = replace_once(
        text,
        'function N(e,t){let n=P(e);return e.turnHistory?.kind==="canonical"?'
        '(0,w.H)(n,e.turns,{policy:t}):n}',
        'function N(e,t){let n=P(e);return __scp.displayTurns('
        'codexSidePatchStorage(),e,e.turnHistory?.kind==="canonical"?'
        '(0,w.H)(n,e.turns,{policy:t}):n)}',
    )
    text = replace_once(
        text,
        "shouldSurfaceRecentConversation(e){return!this.isConversationSuppressed(e.id)&&"
        "!0!==e.ephemeral&&!0!==e.sideConversation&&",
        "shouldSurfaceRecentConversation(e){return"
        "!__scp.isSavedSide(codexSidePatchStorage(),this.params.hostId,e.id)&&"
        "!this.isConversationSuppressed(e.id)&&!0!==e.ephemeral&&!0!==e.sideConversation&&",
    )
    text = replace_once(
        text,
        "shouldSurfaceThreadSummary(e){return!this.isConversationSuppressed(e.conversationId)&&"
        "this.conversations.get(e.conversationId)?.sideConversation!==!0&&",
        "shouldSurfaceThreadSummary(e){return"
        "!__scp.isSavedSide(codexSidePatchStorage(),this.params.hostId,e.conversationId)&&"
        "!this.isConversationSuppressed(e.conversationId)&&"
        "this.conversations.get(e.conversationId)?.sideConversation!==!0&&",
    )
    # Log the exact native fork envelope and response rather than the higher-level helper input.
    text = replace_once(
        text,
        'let c=await s.sendRequest("thread/fork",t.request,i),h=(0,_.J)(c.thread.id);',
        'let c=await(l.sideConversation?__scp.loggedRpc("thread/fork",t.request,()=>'
        's.sendRequest("thread/fork",t.request,i)):s.sendRequest("thread/fork",t.request,i)),'
        'h=(0,_.J)(c.thread.id);',
    )
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
        "sendFollowUpMessage(e,t){return a1(",
        "sendFollowUpMessage(e,t){"
        '__scp.guardSideRequest(codexSidePatchStorage(),this.hostId,"turn/start",'
        "{threadId:e});return a1(",
    )
    text = replace_once(
        text,
        "async sendThreadFollowerRequest(e,t,n,r){if(this.assertActive(),",
        "async sendThreadFollowerRequest(e,t,n,r){"
        "__scp.guardSideRequest(codexSidePatchStorage(),this.hostId,t,n);"
        "if(this.assertActive(),",
    )
    text = replace_once(
        text,
        "this.streamRecovery.markAllConversationsNeedResumeAfterReconnect(e),"
        "this.readState.reset()}async prewarmConversation",
        "this.streamRecovery.markAllConversationsNeedResumeAfterReconnect(e),"
        "this.readState.reset(),__scp.recoverDeletions(this)}async prewarmConversation",
    )
    core_tail = (
        'ew.enum(["config/read","configRequirements/read","account/gatewayOAuth/read",'
        '"account/login/start","account/bedrock/discover","account/bedrock/setup",'
        '"account/gcp/setup"]),p.TF}'
    )
    core_adapter = """
/** Reuse Codex's native persisted-atom store; no second transcript or polling store is added. */
var __codexSideStorage;
/** Return the renderer-local mutation adapter after native persisted state initialization. */
function codexSidePatchStorage(){
  const kv=n("kpIY");
  return __codexSideStorage??=__scp.mutationStorage({
    readValue:key=>kv.TB(key,void 0),
    publish:(key,value)=>kv.jx(key,value),
    subscribe:(key,callback)=>kv.w5(key,void 0,callback),
    clearReply:key=>kv.JQ(key,void 0)
  });
}
/** Lazily create one reactive native KV family for compatibility-registry snapshots. */
var __codexSideRegistryAtom;
/** Resolve the registry family only after Codex's signal runtime is initialized. */
function codexSidePatchRegistryAtom(){
  return __codexSideRegistryAtom??=n("Nwp9").Kn(()=>__scp.REGISTRY_KEY,null);
}
"""
    core_adapter += (ROOT / "hooks/delete-adapter.js").read_text()
    core_adapter += "\n" + (ROOT / "hooks/title-adapter.js").read_text()
    core_adapter += """
n.d(t,{
  codexSidePatchStorage:()=>codexSidePatchStorage,
  codexSidePatchRegistryAtom:()=>codexSidePatchRegistryAtom,
  codexSidePatchRegisterDeletionScope:()=>codexSidePatchRegisterDeletionScope,
  codexSidePatchRegisterDeletionTab:()=>codexSidePatchRegisterDeletionTab,
  codexSidePatchDelete:()=>codexSidePatchDelete,
  codexSidePatchIsFirstTurn:()=>codexSidePatchIsFirstTurn,
  codexSidePatchNameFirstTurn:()=>codexSidePatchNameFirstTurn
});
"""
    text = replace_once(
        text,
        core_tail,
        core_tail[:-1] + ";\n" + core_adapter + "\n}",
    )
    source[name] = IMPORT + text

    # Native side creation, restoration, admission and tab lifecycle now share one Rspack chunk.
    name = "async/299250.3353e2695c.js"
    text = source[name]
    text = replace_once(
        text,
        'uqEk(e,t,n){var r=n("y5DF"),a=n("Oj9r"),o=n("qixt"),s=n("OMIV"),'
        'i=n("moBM");let l=(0,r.un)(a.GD,({get:e})=>e(i.sU)&&'
        '(!e(o.e2)||e(s.JW,"2402779155")));',
        'uqEk(e,t,n){var r=n("y5DF"),a=n("Oj9r"),o=n("qixt"),s=n("OMIV"),'
        'i=n("moBM"),c=n("tl5a");let l=(0,r.un)(a.GD,({get:e,scope:t})=>'
        'e(i.sU)&&(!e(o.e2)||e(s.JW,"2402779155")||'
        '(t.value.routeKind==="local-thread"&&e(c.qX,t.value.conversationId)==="local")));',
    )
    text = replace_once(
        text,
        'AqOV(e,t,n){var r=n("DBCl")',
        'AqOV(e,t,n){var __side=n("SYKY"),__sideIdentity=n("SPnB"),'
        '__sideManager=n("Dgwo"),r=n("DBCl")',
    )
    text = replace_between_after(
        text,
        "AqOV(e,t,n){",
        "async function v(",
        "function g(",
        (ROOT / "hooks/local-create.js").read_text() + "\n",
    )
    text = replace_once(
        text,
        'vBFC(e,t,n){var r=n("SRbQ")',
        'vBFC(e,t,n){var __side=n("SYKY"),r=n("SRbQ")',
    )
    text = replace_between_after(
        text,
        "vBFC(e,t,n){",
        "async function v(",
        "function g(",
        (ROOT / "hooks/restore.js").read_text() + "\n",
    )
    text = replace_once(
        text,
        "uiXp(e,t,n){n.r(t),",
        'uiXp(e,t,n){const __side=n("SYKY"),__sideIdentity=n("SPnB");n.r(t),',
    )
    text = replace_once(
        text,
        "instructionOverrides:(0,I.s)(e.get(C.M9),e.get(l.Zs,s)??"
        "v?.settings.model??null),parentNavigationPath:",
        "assertRequestCurrent:()=>{if(!J.isCurrent())"
        'throw Error("Side chat creation cancelled")},'
        'naming:{phase:"placeholder",baseTitle:K},'
        "instructionOverrides:(0,I.s)(e.get(C.M9),e.get(l.Zs,s)??"
        "v?.settings.model??null),parentNavigationPath:",
    )
    cancel_hook = """let L=async t=>{
if(t.persistent)return;
if(null!=t.durable){
  if(null==j){
    const params={conversationId:t.conversationId,
      options:{useAppServerPins:!1,source:"side-chat-cancelled"}};
    await __scp.loggedRpc("archiveConversation",params,()=>
      (0,i.V)(e,t.hostId).archiveConversation(t.conversationId,params.options));
    if(t.hostId==="local")await __scp.forgetCancelled(
      __side.codexSidePatchStorage(),t.conversationId);
  }
  return;
}
E?.();let n=await ev(e,t.hostId,t.conversationId);k?.(n)}"""
    text = replace_between_after(
        text,
        "uiXp(e,t,n){",
        "let L=async t=>{",
        ",Q=null,Z=null,ee=async()=>",
        cancel_hook,
    )
    identity_check = (
        "__scp.assertUsable(__side.codexSidePatchStorage(),Q.durable,"
        "e.get(__sideIdentity.chatGptAuthenticatedAccountId$),"
        "e.get(__sideIdentity.o8))"
    )
    text = replace_once(
        text,
        "if(!J.isCurrent())return await L(Q),null;",
        "if(!J.isCurrent())return await L(Q),null;" + identity_check + ";",
    )
    text = replace_once(
        text,
        "if(null==Z&&null!=M&&await M(t),!J.isCurrent())",
        "if(null==Z&&null!=M&&await M(t)," + identity_check + ",!J.isCurrent())",
    )
    text = replace_once(
        text,
        "if(et(Q)||(J.fail(A),await L(Q))",
        identity_check + ";if(et(Q)||(J.fail(A),await L(Q))",
    )
    text = replace_once(
        text,
        "et=(a,i)=>{let c,{conversationId:d,hostId:u}=a,p=null!=a.durable||!0===a.persistent;",
        "et=(a,i)=>{let c,{conversationId:d,hostId:u}=a,p=null!=a.durable||!0===a.persistent;"
        "__scp.assertUsable(__side.codexSidePatchStorage(),a.durable,"
        "e.get(__sideIdentity.chatGptAuthenticatedAccountId$),"
        "e.get(__sideIdentity.o8));",
    )
    text = replace_once(
        text,
        "onClose:()=>{c?.();let t=()=>{V.openTab(e,eu,",
        "onClose:()=>{c?.();"
        'a.durable?.hostId==="local"&&Promise.resolve('
        "__scp.hide(__side.codexSidePatchStorage(),d))"
        ".catch(error=>console.error(__scp.errorJSON(error)));"
        "let t=()=>{if(a.durable?.hostId===`local`){try{"
        "__scp.assertUsable(__side.codexSidePatchStorage(),a.durable,"
        "e.get(__sideIdentity.chatGptAuthenticatedAccountId$),"
        "e.get(__sideIdentity.o8));}catch{return;}}V.openTab(e,eu,",
    )
    text = replace_once(
        text,
        "let C=()=>{if(p)return;let t=e.get(V.tabById$,f)?.contentInstance;",
        "let C=()=>{if(a.durable?.hostId===`local`)"
        "return __side.codexSidePatchRegisterDeletionTab(e,a.durable);"
        "if(p)return;let t=e.get(V.tabById$,f)?.contentInstance;",
    )
    source[name] = IMPORT + text

    # Native summary discovery remains authoritative; compatibility rows are merged into it.
    name = "async/357959.de4ec41383.js"
    text = source[name]
    text = replace_once(
        text,
        "S5vq(e,t,n){n.d(t,",
        'S5vq(e,t,n){const __side=n("SYKY"),__sideIdentity=n("SPnB");n.d(t,',
    )
    summary_selector = """let a$=(0,a.un)(f.GD,({get:e,scope:t})=>{
let d=e(aF.v).data,n=new Map(d?.children.map(e=>[e.id,e])),r=new Map;
for(let t of["right","bottom"])
  for(let n of e((0,eC.getThreadPanelTabController)(t).tabs$))
    n.tabId.startsWith(aH.y0)&&r.set((0,l.JXB)(n.tabId.slice(aH.y0.length)),n.title);
const nativeRows=[...new Set([...r.keys(),...n.keys()])].map((s,a)=>{
  let l=n.get(s),i={hostId:null!=l&&null!=d?d.hostId:e(o.qX,s),threadId:s},
    c=e(o.ok,i),u=r.get(s)??l?.title??(0,aW.c)(e(n3.g),a+1);
  return{conversationId:s,tabId:`${aH.y0}${s}`,title:u,
    isResponseInProgress:c?.isConversationInProgress??l?.isResponseInProgress??!1,
    hasUnreadTurn:c?.summary.hasUnreadTurn??e(aq.I,i)??l?.hasUnreadTurn??!1,
    savedThread:null==l?null:i};
});
return __scp.summaryRows(e(__side.codexSidePatchRegistryAtom(),void 0),nativeRows,{
  accountId:e(__sideIdentity.chatGptAuthenticatedAccountId$),
  userId:e(__sideIdentity.o8),sourceConversationId:t.value.conversationId
})});"""
    text = replace_between_after(
        text,
        "S5vq(e,t,n){",
        "let a$=",
        "var az=",
        summary_selector,
    )
    text = replace_once(
        text,
        "n=e=>{let t=(0,eC.KE)(c,e.tabId);",
        "n=e=>{if(e.deletion)return;if(e.isSavedClosed&&e.durable){"
        "(0,n4.openLocalConversationSideChat)(c,aO.LocalConversationSideChatTab,{"
        "durable:e.durable,sourceConversationId:e.durable.sourceConversationId,"
        "hostId:e.durable.hostId,cwd:null,"
        "collaborationMode:e.durable.collaborationMode,displayTitle:e.title,intl:u})"
        ".then(e=>{null!=e&&(0,aB.U)(c,e)}).catch(e=>c.get(tS.Id).danger("
        "(0,l.Rt_)(e),{errorAnalytics:{toastId:"
        '"localConversation.sideChat.openFailed"}}));return}'
        "let t=(0,eC.KE)(c,e.tabId);",
    )
    text = replace_between_after(
        text,
        "OMEl(e,t,n){",
        "function d(",
        "function h(",
        (ROOT / "hooks/side-list.js").read_text() + "\n",
    )
    source[name] = IMPORT + text

    # Composer success and native title cleanup retain native text processing and update one row.
    name = "async/589850.4264f95e93.js"
    text = replace_once(
        source[name],
        "aVy5(e,t,n){n.d(t,",
        'aVy5(e,t,n){const __side=n("SYKY");n.d(t,',
    )
    text = replace_count(
        text,
        "(e.get(p.VT,",
        "(__side.codexSidePatchIsFirstTurn(e,",
        2,
    )
    text = replace_count(
        text,
        ")??0)===0",
        "))",
        2,
    )
    source[name] = IMPORT + text

    name = "async/563813.7486e43f6b.js"
    text = replace_once(
        source[name],
        "OUOZ(e,t,n){var ",
        'OUOZ(e,t,n){const __side=n("SYKY");var ',
    )
    text = replace_once(
        text,
        "function c(e,t,n,o){null==e.get(a.HX,{hostId:t,threadId:n})&&d(e,n,l(o))}",
        "function c(e,t,n,o){let r=l(o);"
        "if(__scp.isSavedSide(__side.codexSidePatchStorage(),t,n))"
        "__side.codexSidePatchNameFirstTurn(e,n,r)"
        ".catch(error=>console.error(__scp.errorJSON(error)));"
        "else null==e.get(a.HX,{hostId:t,threadId:n})&&d(e,n,r)}",
    )
    source[name] = IMPORT + text

    result = {
        "webview/assets/" + name: value.encode("utf-8")
        for name, value in source.items()
    }
    result[RUNTIME_PATH] = (ROOT / "runtime/persistence.mjs").read_bytes()
    for name, digest in MAIN_ASSETS.items():
        original = read_file(archive, name)
        if sha256_bytes(original) != digest:
            raise ValueError("Unknown original main-process asset: " + name)
        text = replace_once(
            original.decode("utf-8"),
            "updatePersistedAtomState(e,t,r,n){",
            "updatePersistedAtomState(e,t,r,n){"
            "let __sideState=__codexSideState.handle(this,e,t,r);"
            "if(__sideState.handled)return;r=__sideState.value;",
        )
        result[name] = (
            'const __codexSideState=require("./codex-native-side-state-v1.cjs");\n' + text
        ).encode("utf-8")
    result[".vite/build/codex-native-side-state-v1.cjs"] = (
        ROOT / "runtime/main-state.cjs"
    ).read_bytes()
    return result


def implementation_digest():
    """Pin templates, adapter and signing policy so stale staged packages are always rebuilt."""
    files = [
        ROOT / "patchkit/profile.py",
        ROOT / "runtime/persistence.mjs",
        ROOT / "runtime/main-state.cjs",
        ROOT / "hooks/local-create.js",
        ROOT / "hooks/restore.js",
        ROOT / "hooks/delete-adapter.js",
        ROOT / "hooks/title-adapter.js",
        ROOT / "hooks/side-list.js",
        ROOT / "hooks/summary.js",
        ROOT / "patchkit/manager.py",
        ROOT / "patchkit/integrity.py",
    ]
    return sha256_bytes(b"".join(path.read_bytes() for path in files))

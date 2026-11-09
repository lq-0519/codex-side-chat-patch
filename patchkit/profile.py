"""Exact build 25894 adapter for native Rspack modules, RPC and persistent side-chat state."""

from pathlib import Path
import re

from .archive import read_file, sha256_bytes


# PROFILE rejects every other vendor archive, desktop build and bundled CLI before staging.
PROFILE = {
    "id": "codex-25894-rspack-side-v1",
    "bundle_id": "com.openai.codex",
    "version": "26.1103.60933",
    "build": "25894",
    "cli_version": "0.167.0-alpha.3.2",
    "asar_sha256": "a77588b2dcfa9b394d722dd8c2c8b13d3a09bacd49c839cc715245742dba6048",
}
# ASSETS covers all packaged copies of the patched factories, including lazy renderer entries.
ASSETS = {
    "async/142858.bb74e6a40a.js": "f1c8965b2a945c8f6d8a72997a90d8b7d236fa984fd01bdb9ea145a4290d31b0",
    "async/155395.08778d49f4.js": "07b8641851d1dc6a4d7e075a336d8a7093e6a6c8621aed03b21b70501490b8fe",
    "async/161445.832141020f.js": "b51ae750f6a856fa9b3234c40de31a20c3386340df5b4f9c43dda96a88cfc4df",
    "async/182735.7f13786b92.js": "119afcc814fe83e733d5b494d3201afe203c51b8d059998b2a8dbf3ed03ccd85",
    "async/188990.e6afd3f98c.js": "ff5b833b8e0aef487f4ac9ef257eadf4c21d6ec4abee912b716905add5a2ab50",
    "async/258933.468d7cad16.js": "af0af9260268b1109d5597f3f6d25e9d26aec5d56581a707903a0d330b35488c",
    "async/268292.c434c9f4de.js": "acbd12a27e6263fc6431ca02b82a6f7207303dec4a3a796689baa358ff2293c9",
    "async/276191.35b78dfd42.js": "79f8fdba126ee6cef86e96fdc30b9a4db5e01a8d437cdbe4cb17f2ea814655ab",
    "async/283304.2f3555f945.js": "bea83519d5dbe8ac5ac7a24320329d8269b85821001031abb2386633effc5489",
    "async/291906.d535e4f0a2.js": "dcd2a602c20906bbc6be37c374259ac6fa67250c41d27793425782dafe9ed5eb",
    "async/309092.4d5eb15e40.js": "a2b7b99745c6f7eefb94acbbad8b120f51f9ef793496f9296fadb4684fc98201",
    "async/309406.8bbeca04ca.js": "ff04e379a8799b1f0d46de4df2387a63d99714e3aae27e174b8f528f0f5b3877",
    "async/384375.45e1f0cefc.js": "fe3e3af2f086f7fc7d44cccb7671cfa634dbc5adb55ce753446dcc499e7a7386",
    "async/400527.37cd4d5d80.js": "6fbec11422b9679bd6fd6f121810f394c27580afb4e59111fe009acff4bb5271",
    "async/40728.eecdd20f4f.js": "f4cc3ebc944757f732747f66170367b877d19dd68c29e6243845c04df550973f",
    "async/442732.55aa44d192.js": "1cc851a1438db8012f7711bc34452a4de4d3ee100762ef2289df1c2bad1a720a",
    "async/463815.e873fca346.js": "c5ad1a6bb66a19f79b07f6259f435872cb631ff731381fa7efdd4398a98875ce",
    "async/481136.7bb81d6bb2.js": "f2312245eab2f21d1ce30da68a889939ad0e9d912423443c2919325a6a594162",
    "async/499225.6d2e47bea2.js": "80f7a6b651f9f56ac97463123d72963c2a78570f6f0162c75d0d6d9d0a03f074",
    "async/503951.d3dccca0f7.js": "f46926c7c49b6fc33badec2f236a7e3a1de9b9c4f0e5bc633993133dc93c3209",
    "async/529279.b16e3224ce.js": "a3de670fc8759f1d86ec889f9ab833e7ccb5d3810a6935db39ae5f86da5d5c02",
    "async/560402.35df7b0a7b.js": "4cdfc5ef8940a626349472e8dde07d9449e3f48217b8f7850c97377de343dd20",
    "async/600078.a00c7dbf6f.js": "b90de14c92a6853dac7856ba95d95d4b514c1444c7d674e3ac78f367bdd04674",
    "async/620182.5dff767066.js": "f4ec9d6e6a752a1b072456144a1ba4b02b9ed3997c06a4c02d67414eb420e5d0",
    "async/654400.4ebcf54c6e.js": "38fcd00112fcdf46aab67fb515d370269fdc3ddcb39550d95d01218031e353ad",
    "async/848943.e1a90d7643.js": "6f346a30fcf7e20f353a4e468cb0c532d2199d0af880dad5027965a395b80955",
    "async/851215.3a3b02a3eb.js": "6d21d00c6583519506795ea2122e65bb381b93722be94e2e9490ccc22356bb26",
    "async/870918.5e1155e232.js": "9d0f6f65b17d4e8db1b5acdbfab92ca46099aa4ad047ee2530128bb9a5b7a99f",
    "async/878027.d0f161321c.js": "4e71508e6f2f3f49ba4d5641dd5c2b57f05c23355fc8effe43c964f86a47c325",
    "async/884779.bf167971f9.js": "cdc694546dbda438c12a929e692381b1c8c186d4cad9257e69ad5b4163d72d84",
    "async/940378.b7364697b6.js": "78c05899460fd1c9ad99b4f7c60f0846b4f1187c2aa984a07cb110b844b08fbd",
    "async/942958.672a7efbf6.js": "77eba884535a0d3c15261bd8162e571b6254d70f005ff22c668ccf7efd0040c4",
    "async/971326.06a1338e1c.js": "ff9febff0e417853057b731acd0609efc3602842c9209ec202bdf8c4927077d3",
    "async/996862.96b8439b8a.js": "0bb99c580eff8d6916020ce43968aec019e28f14301925d32e1546c6b0d991f2",
}
# MODULE_LENGTHS records Acorn-extracted factory lengths in decoded Python characters. All
# boundaries are located in original hash-verified chunks before edits, so injected comments
# cannot alter later module spans. Inner aliases may differ across copies and are read locally.
MODULE_LENGTHS = {
    "V7mA": 712168, "Dgwo": 1185, "nJj6": 845, "t3Ye": 10520,
    "m22M": 560, "N42N": 3883, "kB0c": 13568, "uiXp": 17192,
    "AqOV": 2215, "vBFC": 3617, "uqEk": 166, "OUOZ": 596,
    "WRqP": 555, "aVy5": 26563, "OMEl": 1731, "KVWT": 180352, "x9Bi": 178604,
}
# MODULE_COPY_COUNTS rejects incomplete adapters when a packaged duplicate was overlooked.
MODULE_COPY_COUNTS = {
    "V7mA": 1, "Dgwo": 1, "nJj6": 1, "t3Ye": 1, "m22M": 1,
    "N42N": 1, "kB0c": 1, "uiXp": 4, "AqOV": 4, "vBFC": 5,
    "uqEk": 9, "OUOZ": 9, "WRqP": 15, "aVy5": 1, "OMEl": 2, "KVWT": 1, "x9Bi": 1,
}
# MAIN_ASSETS independently pins native main-process persistence and deletion coordination.
MAIN_ASSETS = {
    ".vite/build/early-bootstrap-815-e030c49be4b9c405.js":
        "67c10f58239453fba595f83917fda3756ac2f40ef87fe5f70dd143d4ecef6ad1",
}
# ROOT locates tracked implementation templates; all extraction output remains outside Git.
ROOT = Path(__file__).resolve().parents[1]
# RUNTIME_PATH remains an ordinary ESM dependency of the patched Rspack chunks.
RUNTIME_PATH = "webview/assets/codex-native-side-patch-v1.mjs"
IMPORT = 'import*as __scp from"../codex-native-side-patch-v1.mjs";\n'


def replace_once(text, old, new):
    """Require one exact native anchor within an already isolated factory."""
    if text.count(old) != 1:
        raise ValueError("Non-unique patch anchor: " + repr(old[:160]))
    return text.replace(old, new, 1)


def replace_count(text, old, new, expected):
    """Require a known count of equivalent anchors without matching unrelated module scopes."""
    if text.count(old) != expected:
        raise ValueError(f"Expected {expected} patch anchors, found {text.count(old)}: {old[:120]!r}")
    return text.replace(old, new)


def exact_match(pattern, text):
    """Resolve one build-specific structural anchor and reject both missing and duplicate hits."""
    matches = list(re.finditer(pattern, text))
    if len(matches) != 1:
        raise ValueError("Non-unique module structure: " + pattern)
    return matches[0]


def replace_region(text, beginning, following, replacement):
    """Replace a verified single region while retaining both neighboring native boundaries."""
    start = exact_match(re.escape(beginning), text).start()
    end = text.find(following, start + len(beginning))
    if end < 0:
        raise ValueError("Missing patch region end: " + following)
    return text[:start] + replacement + text[end:]


def template(name):
    """Load a reviewed tracked hook as UTF-8 without creating an extraction file."""
    return (ROOT / "hooks" / name).read_text()


def require_alias(text):
    """Read each duplicate factory's own Rspack require parameter instead of reusing old aliases."""
    return exact_match(r"^\w+\(\w+,\w+,(\w+)\)\{", text).group(1)


def inject_require(text):
    """Give hook templates a stable local require alias while retaining every native declaration."""
    marker = exact_match(r"^\w+\(\w+,\w+,\w+\)\{", text).group()
    return replace_once(text, marker, marker + f"const __require={require_alias(text)};")


def patch_core(text):
    """Keep native history, RPC envelopes and facade classes intact; append renderer adapters."""
    history = (
        'function D(e,t){let n=k(e);return e.turnHistory?.kind==="canonical"?'
        '(0,R.H)(n,e.turns,{policy:t}):n}'
    )
    text = replace_once(text, history, history)
    text = replace_once(text, "return{id:n,title:e.name,hasUnreadTurn:",
                        "return{id:n,title:e.name,createdAt:e.createdAt,hasUnreadTurn:")
    text = replace_once(
        text,
        'let h=await s.sendRequest("thread/fork",n.request,c),_=(0,g.J)(h.thread.id);',
        'let h=await(l.sideConversation?__scp.loggedRpc("thread/fork",n.request,()=>'
        's.sendRequest("thread/fork",n.request,c)):s.sendRequest("thread/fork",n.request,c)),'
        '_=(0,g.J)(h.thread.id);',
    )
    adapter = """
/** Reuse the initialized renderer KV; the native RPC worker owns no duplicate transcript index. */
var __codexSideStorage;
/** Resolve the renderer-local mutation channel only after persisted atoms are initialized. */
function codexSidePatchStorage(){
  const kv=n("kpIY");
  return __codexSideStorage??=__scp.mutationStorage({
    readValue:key=>kv.TB(key,void 0),
    publish:(key,value)=>kv.jx(key,value),
    subscribe:(key,callback)=>kv.w5(key,void 0,callback),
    clearReply:key=>kv.JQ(key,void 0)
  });
}
/** One native signal family follows replacement snapshots from the main-process registry. */
var __codexSideRegistryAtom;
/** Create the family lazily after native signals have initialized. */
function codexSidePatchRegistryAtom(){
  return __codexSideRegistryAtom??=n("Nwp9").Kn(()=>__scp.REGISTRY_KEY,null);
}
"""
    adapter += template("delete-adapter.js") + "\n" + template("title-adapter.js")
    adapter += """
n.d(t,{
  codexSidePatchStorage:()=>codexSidePatchStorage,
  codexSidePatchRegistryAtom:()=>codexSidePatchRegistryAtom,
  codexSidePatchRegisterDeletionScope:()=>codexSidePatchRegisterDeletionScope,
  codexSidePatchRegisterDeletionTab:()=>codexSidePatchRegisterDeletionTab,
  codexSidePatchDelete:()=>codexSidePatchDelete,
  codexSidePatchTitle:()=>codexSidePatchTitle,
  codexSidePatchSidebarTask:()=>codexSidePatchSidebarTask,
  codexSidePatchRename:()=>codexSidePatchRename,
  codexSidePatchIsFirstTurn:()=>codexSidePatchIsFirstTurn,
  codexSidePatchNameFirstTurn:()=>codexSidePatchNameFirstTurn
});
"""
    return text[:-1] + ";\n" + adapter + "\n}"


def patch_panel(text):
    """Adapt all four native pending-tab transactions using their own local lifecycle aliases."""
    text = inject_require(text)
    header = exact_match(r"const __require=\w+;", text).group()
    text = replace_once(text, header, header + 'const __side=__require("V7mA"),'
                        '__sideIdentity=__require("SPnB");' + template("panel-open.js"))
    # These names come from the exact pinned function signature and pending-tab transaction.
    opening = exact_match(r"async function (\w+)\(e,t,\{Icon:n=.*?sourceConversationId:(\w+),"
                          r"threadSource:(\w+)=.*?cwd:(\w+),hostId:(\w+),.*?"
                          r"onDiscard:(\w+),onDiscardStart:(\w+),.*?durable:(\w+),", text)
    _, parent, _, _, host, discard, discard_start, durable = opening.groups()
    pending = exact_match(r"if\(null==([\w$]+)\)return null;(\w+)&&null!=([\w$]+)", text)
    pending_id, focus, client_id = pending.groups()
    reveal = exact_match(r"let (\w+)=\(0,\w+\.getThreadPanelTabController\)", text).group(1)
    title = exact_match(r"([\w$]+)=[\w$]+\?\?\(0,\w+\.c\)\([\w$]+,[\w$]+\)", text).group(1)
    anchor = pending.group()
    text = replace_once(text, anchor, f"if(null=={pending_id})return null;"
                        f"codexSidePatchRevealSplit(e,{reveal},{host},{focus});{focus}&&null!={client_id}")
    text = replace_once(
        text, "instructionOverrides:",
        f'assertRequestCurrent:()=>{{if(!{pending_id}.isCurrent())'
        'throw Error("Side chat creation cancelled")},'
        f'naming:{{phase:"placeholder",baseTitle:{title}}},instructionOverrides:',
    )
    cancel = exact_match(r"(\w+)=async t=>\{if\(t.persistent\)return;.*?"
                         r"let n=await (\w+)\(e,t.hostId,t.conversationId\);\w+\?\.\(n\)\}", text)
    cancel_name, native_discard = cancel.groups()
    replacement = f"""{cancel_name}=async t=>{{
if(t.persistent)return;
if(null!=t.durable){{
  if(null=={durable}){{
    const params={{conversationId:t.conversationId,
      options:{{useAppServerPins:!1,source:"side-chat-cancelled"}}}};
    await __scp.loggedRpc("archiveConversation",params,()=>
      (0,__require("Dgwo").V)(e,t.hostId).archiveConversation(t.conversationId,params.options));
    if(t.hostId==="local")await __scp.forgetCancelled(
      __side.codexSidePatchStorage(),t.conversationId);
  }}
  return;
}}
{discard_start}?.();let n=await {native_discard}(e,t.hostId,t.conversationId);{discard}?.(n)}}"""
    text = replace_once(text, cancel.group(), replacement)
    current = exact_match(r"if\(!" + pending_id + r"\.isCurrent\(\)\)return await "
                          + cancel_name + r"\((\w+)\),null;", text)
    result = current.group(1)
    identity = (
        f"__scp.assertUsable(__side.codexSidePatchStorage(),{result}.durable,"
        "e.get(__sideIdentity.chatGptAuthenticatedAccountId$),e.get(__sideIdentity.o8))"
    )
    text = replace_once(text, current.group(), current.group() + identity + ";")
    preparation = exact_match(r":(\w+)=void 0,!"+pending_id+r"\.isCurrent\(\)\)", text)
    text = replace_once(text, preparation.group(),
                        f":{preparation.group(1)}=void 0," + identity + f",!{pending_id}.isCurrent())")
    admission = exact_match(r"if\((\w+)\(" + result + r"\)\|\|", text).group()
    text = replace_once(text, admission, identity + ";" + admission)
    admitted = exact_match(r"(\w+)=\((\w+),\w+\)=>\{let (\w+),"
                           r"\{conversationId:(\w+),hostId:(\w+)\}=\2,", text)
    admit_header = admitted.group()
    _, accepted, cleanup, conversation, _ = admitted.groups()
    accepted_identity = (
        f"if({accepted}.durable)__scp.assertUsable(__side.codexSidePatchStorage(),"
        f"{accepted}.durable,e.get(__sideIdentity.chatGptAuthenticatedAccountId$),"
        "e.get(__sideIdentity.o8));"
    )
    text = replace_once(
        text, admit_header, admit_header.replace(f"let {cleanup},",
                                                accepted_identity + f"let {cleanup},"),
    )
    close = f"onClose:()=>{{{cleanup}?.();let t=()=>{{{reveal}.openTab(e,"
    text = replace_once(
        text, close,
        f'onClose:()=>{{{cleanup}?.();{accepted}.durable?.hostId==="local"&&'
        f"Promise.resolve(__scp.hide(__side.codexSidePatchStorage(),{conversation}))"
        ".catch(error=>console.error(__scp.errorJSON(error)));"
        f"let t=()=>{{if({accepted}.durable?.hostId===`local`){{try{{"
        f"__scp.assertUsable(__side.codexSidePatchStorage(),{accepted}.durable,"
        "e.get(__sideIdentity.chatGptAuthenticatedAccountId$),e.get(__sideIdentity.o8));"
        f"}}catch{{return;}}}}{reveal}.openTab(e,",
    )
    register = exact_match(r"let (\w+)=\(\)=>\{if\((\w+)\)return;let t=e.get\("
                           + reveal + r"\.tabById\$,(\w+)\)", text).group()
    return replace_once(
        text, register, register.replace("if(", f'if({accepted}.durable?.hostId===`local`)'
        f"return __side.codexSidePatchRegisterDeletionTab(e,{accepted}.durable);if(", 1),
    )


def patch_summary(text):
    """Merge owned saved rows with native metadata without changing native discovery or menus."""
    text = replace_once(text, "x9Bi(e,t,n){", 'x9Bi(e,t,n){const __side=n("V7mA"),'
                        '__sideIdentity=n("SPnB");')
    text = replace_once(text, "let sZ=(0,s.un)(f.GD,({get:e})=>{",
                        "let sZ=(0,s.un)(f.GD,({get:e,scope})=>{")
    text = replace_once(text, "return[...new Set([...r.keys(),...n.keys()])].map((a,s)=>{",
                        "const nativeRows=[...new Set([...r.keys(),...n.keys()])].map((a,s)=>{")
    text = replace_once(text, "title:d,isResponseInProgress:",
                        "title:d,createdAt:Number.isFinite(l?.createdAt)&&l.createdAt>0?"
                        "l.createdAt*1000:void 0,isResponseInProgress:")
    text = replace_once(
        text, "savedThread:null==l?null:o}})});function sQ()",
        "savedThread:null==l?null:o}});return __scp.summaryRows("
        "e(__side.codexSidePatchRegistryAtom(),void 0),nativeRows,{"
        "accountId:e(__sideIdentity.chatGptAuthenticatedAccountId$),"
        "userId:e(__sideIdentity.o8),sourceConversationId:scope.value.conversationId"
        "})});function sQ()",
    )
    return replace_once(
        text, "n=e=>{let t=(0,eA.KE)(c,e.tabId);",
        "n=e=>{if(e.deletion)return;if(e.isSavedClosed&&e.durable){"
        "(0,n9.openLocalConversationSideChat)(c,sK.LocalConversationSideChatTab,{"
        "durable:e.durable,sourceConversationId:e.durable.sourceConversationId,"
        "hostId:e.durable.hostId,cwd:null,collaborationMode:e.durable.collaborationMode,"
        "displayTitle:e.title,intl:d}).then(e=>{null!=e&&(0,sF.U)(c,e)})"
        ".catch(e=>c.get(tP.Id).danger((0,l.Rt_)(e),{errorAnalytics:{toastId:"
        '"localConversation.sideChat.openFailed"}}));return}let t=(0,eA.KE)(c,e.tabId);',
    )


def patch_module(module, text):
    """Apply the reviewed semantic adapter inside one exact original factory, never across scopes."""
    if module == "V7mA":
        return patch_core(text)
    if module == "Dgwo":
        # Guards must run in the renderer, where native persisted KV is initialized. The new
        # worker RPC facade intentionally carries no renderer registry or synchronous history.
        text = replace_once(text, "n.d(t,{},{V:function(e,t){", "function codexSideNativeRpc(e,t){")
        return replace_once(
            text, "},p:d})}",
            '}n.d(t,{},{V:(e,t)=>__scp.guardedSideRpc('
            'n("V7mA").codexSidePatchStorage(),t,codexSideNativeRpc(e,t)),p:d})}',
        )
    if module == "nJj6":
        return replace_once(text, "let a=i.strictObject({",
                            "let a=i.strictObject({patchVersion:i.literal(1).optional(),")
    if module == "t3Ye":
        text = replace_once(text, 'var r=n("V7mA"),', 'var __side=n("V7mA"),r=n("V7mA"),')
        options = (
            "conversationRequests:s,isAeonThread:o,showPartialHistoryGaps:o&&p.hostId===d.iwv,"
            "mergeBerryDisplayTurnsForPIA:!1,preserveServerUserMessages:o||!1,"
            "conversationTurns:N,hasConversation:a,historyEntriesByTurnIndex:D?E:void 0,"
            "historyTimeline:D?y??void 0:void 0,isBackgroundSubagentsEnabled:t,"
            "hideReactionInputs:!1,inheritedHistoryPositionKeys:L,parentConversationTurns:F,"
            "parentHistoryComplete:k,childCreatedAt:n(h.Kz,e),subagentParentThreadId:u,"
            "turnEntityKeys:w?.map(({entityKey:e})=>e)"
        )
        return replace_once(
            text, "return M({" + options + "})})",
            'p.hostId==="local"&&n(__side.codexSidePatchRegistryAtom(),void 0);'
            "return M(__scp.presentationOptions(__side.codexSidePatchStorage(),"
            "{id:e,hostId:p.hostId},{" + options + "}))})",
        )
    if module in {"m22M", "N42N", "kB0c", "aVy5"}:
        text = replace_once(text, module + "(e,t,n){",
                            module + '(e,t,n){const __side=n("V7mA");')
    if module == "m22M":
        return replace_once(
            text, "let n={hostId:t(a.qX,e),threadId:e},r=t(s.Qq,e);",
            "let n={hostId:t(a.qX,e),threadId:e};"
            "const title=__side.codexSidePatchTitle(t,n.hostId,e);"
            "if(title!=null)return title;let r=t(s.Qq,e);",
        )
    if module == "N42N":
        return replace_once(text, "return null==r?[]:[{task:r,isPinned:",
                            "return null==r?[]:[{task:__side.codexSidePatchSidebarTask(e,r),isPinned:")
    if module == "kB0c":
        text = replace_once(text, 'const __side=n("V7mA");',
                            'const __side=n("V7mA"),__sideTitleClean=n("t162").uw;')
        anchor = "function Y(e,{conversationId:t,hostId:n,previousTitle:r,title:i},a){"
        return replace_once(text, anchor, anchor + template("sidebar-rename.js"))
    if module == "AqOV":
        text = inject_require(text)
        text = replace_region(text, "O:async function(", ",c:function(", "O:codexSideCreate")
        return text[:-1] + "\n" + template("local-create.js") + "\n}"
    if module == "vBFC":
        text = inject_require(text)
        text = replace_region(text, "q:async function(", "}})}", "q:codexSideRestore")
        # The original trailing brace belongs to q; retain only n.d and the module closing braces.
        text = replace_once(text, "q:codexSideRestore}})}", "q:codexSideRestore})}")
        return text[:-1] + "\n" + template("restore.js") + "\n}"
    if module == "uiXp":
        return patch_panel(text)
    if module == "KVWT":
        text = replace_once(text, "KVWT(e,t,n){", 'KVWT(e,t,n){const __side=n("V7mA");')
        return replace_once(
            text, "{data:tC}=(0,s._U)(ri,tj?t:null),tk=",
            "{data:tC}=__scp.navigationHistoryQuery(__side.codexSidePatchStorage(),"
            "{id:t,hostId:a},(0,s._U)(ri,tj?t:null)),tk=",
        )
    if module == "x9Bi":
        return patch_summary(text)
    if module == "OMEl":
        return "OMEl(e,t,n){\n" + template("side-list.js") + "\nn.d(t,{},{y:d})}"
    if module == "aVy5":
        return replace_count(text, "(e.get(f.VT,", "(__side.codexSidePatchIsFirstTurn(e,", 2).replace(
            ")??0)===0", "))")
    if module == "uqEk":
        return """uqEk(e,t,n){
var signals=n("zTeN"),scope=n("Oj9r"),mode=n("qixt"),flags=n("OMIV"),
    enabled=n("moBM"),threads=n("tl5a");
let gate=(0,signals.un)(scope.GD,({get:e,scope:t})=>e(enabled.sU)&&
  (!e(mode.e2)||e(flags.JW,"2402779155")||
    (t.value.routeKind==="local-thread"&&e(threads.qX,t.value.conversationId)==="local")));
n.d(t,{},{f:gate})}"""
    if module == "OUOZ":
        return """OUOZ(e,t,n){
const nativeMarkdown=n("NRIv"),signals=n("tl5a"),panels=n("XXJV"),
  nativeText=n("L2Eu"),routes=n("mR55"),side=n("V7mA");
/** Retain native Markdown cleanup and whitespace semantics for the first response title. */
function clean(e){let t=(0,nativeText.SX)((0,nativeMarkdown.Dh)(e).trim());return t.length>0?t:null}
/** Preserve native tab and durable-route title updates for ordinary side chats. */
function update(e,t,title){
  if(title==null)return;let target=e.get(panels.My,t);if(target==null)return;
  let controller=panels.getThreadPanelTabController(target),tab=e.get(controller.tabById$,t);
  if(tab==null||tab.title===title)return;let route=tab.durableRoute;
  controller.updateTab(e,t,{title,durableRoute:
    typeof route?.params!=="object"||route.params==null||Array.isArray(route.params)?route:
      {...route,params:{...route.params,title}}});
}
/** Persist one owned first-turn title; ordinary hosts keep native title admission. */
function first(e,hostId,id,input){
  const title=clean(input);
  if(__scp.isSavedSide(side.codexSidePatchStorage(),hostId,id))
    side.codexSidePatchNameFirstTurn(e,id,title).catch(error=>console.error(__scp.errorJSON(error)));
  else if(e.get(signals.HX,{hostId,threadId:id})==null)update(e,`${routes.y0}${id}`,title);
}
n.d(t,{},{V1:first,gx:clean,oQ:update})}"""
    if module == "WRqP":
        require = require_alias(text)
        marker = exact_match(r"^\w+\(\w+,\w+,\w+\)\{", text).group()
        getter = exact_match(r"\(e,\{get:(\w+)\}\)=>\{if\(null==e\)return null;", text).group(1)
        text = replace_once(text, marker, marker + f'const __side={require}("V7mA");')
        return replace_once(text, "if(null==e)return null;",
                            template("sidebar-title.js").replace("codexSidePatchTitle(t,",
                                                                  f"codexSidePatchTitle({getter},"))
    raise ValueError("Unsupported native module: " + module)


def build_replacements(archive):
    """Verify complete assets, patch exact original spans and enforce duplicate coverage counts."""
    result, counts = {}, dict.fromkeys(MODULE_LENGTHS, 0)
    for name, digest in ASSETS.items():
        original = read_file(archive, "webview/assets/" + name)
        if sha256_bytes(original) != digest:
            raise ValueError("Unknown original Rspack chunk: " + name)
        text, spans = original.decode("utf-8"), []
        for module, length in MODULE_LENGTHS.items():
            matches = list(re.finditer(r"\b" + module + r"\(\w+,\w+,\w+\)\{", text))
            if len(matches) > 1:
                raise ValueError("Duplicate native factory: " + module)
            if not matches:
                continue
            start = matches[0].start()
            end = start + length
            if text[end - 1] != "}" or text[end:end + 1] not in {",", "}"}:
                raise ValueError("Unknown native factory boundary: " + module)
            spans.append((start, end, module))
            counts[module] += 1
        for start, end, module in sorted(spans, reverse=True):
            text = text[:start] + patch_module(module, text[start:end]) + text[end:]
        result["webview/assets/" + name] = (IMPORT + text).encode("utf-8")
    if counts != MODULE_COPY_COUNTS:
        raise ValueError("Incomplete native factory coverage: " + repr(counts))
    result[RUNTIME_PATH] = (ROOT / "runtime/persistence.mjs").read_bytes()
    for name, digest in MAIN_ASSETS.items():
        original = read_file(archive, name)
        if sha256_bytes(original) != digest:
            raise ValueError("Unknown original main-process asset: " + name)
        text = replace_once(
            original.decode("utf-8"), "updatePersistedAtomState(e,t,r,n){",
            "updatePersistedAtomState(e,t,r,n){"
            "let __sideState=__codexSideState.handle(this,e,t,r);"
            "if(__sideState.handled)return;r=__sideState.value;",
        )
        result[name] = ('const __codexSideState=require("./codex-native-side-state-v1.cjs");\n'
                        + text).encode("utf-8")
    result[".vite/build/codex-native-side-state-v1.cjs"] = (ROOT / "runtime/main-state.cjs").read_bytes()
    return result


def implementation_digest():
    """Pin all tracked templates, adapter and signing policy so stale stages cannot be installed."""
    files = [
        ROOT / "patchkit/profile.py", ROOT / "runtime/persistence.mjs",
        ROOT / "runtime/main-state.cjs", ROOT / "hooks/local-create.js",
        ROOT / "hooks/restore.js", ROOT / "hooks/panel-open.js",
        ROOT / "hooks/delete-adapter.js", ROOT / "hooks/title-adapter.js",
        ROOT / "hooks/sidebar-title.js", ROOT / "hooks/sidebar-rename.js",
        ROOT / "hooks/side-list.js", ROOT / "hooks/summary.js",
        ROOT / "patchkit/manager.py", ROOT / "patchkit/integrity.py",
    ]
    return sha256_bytes(b"".join(path.read_bytes() for path in files))

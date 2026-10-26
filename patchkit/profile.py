"""Exact build adapter; no global ephemeral substitution or bundled vendor source copies."""

from pathlib import Path

from .archive import read_file, sha256_bytes


# PROFILE pins the app, engine and complete original archive inspected for this adapter.
PROFILE = {
    "id": "codex-21828-native-side-v1",
    "bundle_id": "com.openai.codex",
    "version": "26.1021.31345",
    "build": "21828",
    "cli_version": "0.164.0-alpha.11.1",
    "asar_sha256": "130145706a912db74e4d260ad7538f10f1e05e88af955f9afba42cdf01e64606",
}
# ASSETS are the exact target bytes. Matching the version alone is never sufficient.
ASSETS = {
    "local-conversation-side-chat-96a703d918a9.js":
        "ff7f247aeccc978180baca5aa8d7d28f95317fe7934e937d0191a1f1fcb81e22",
    "app-initial-feb30b196d11.js":
        "8f4e5fe65617413cabf689afbfc04bc6c24f73a5c0b57d7d0de443942343bd55",
    "persistent-e62eb8d90af6.js":
        "b6414e8a80a8df06a07223db3342f6af2f55ea7f1c3611e87a832f306412bfaa",
    "local-conversation-thread-f8411a03e6c2.js":
        "4f94f2c3ec4fac892800f78f791c76615f29545f888454dee2f1db7b1f8e183f",
}
# ROOT locates tracked templates only; all extraction and validation output stays outside Git.
ROOT = Path(__file__).resolve().parents[1]
# RUNTIME_PATH is a new relative ESM module in the existing ASAR asset directory.
RUNTIME_PATH = "webview/assets/codex-native-side-patch-v1.mjs"
# IMPORT shares stateless helpers without introducing a dependency on application initialization.
IMPORT = 'import*as __scp from"./codex-native-side-patch-v1.mjs";\n'
# SIDE_IMPORT exposes native identity atoms and persistent storage, preserving account boundaries.
SIDE_IMPORT = (
    'import{ler as __sideAccount,b7n as __sideUser,g5n as __sideIntl,'
    'codexSidePatchStorage as __sideStorage,'
    'codexSidePatchRegistryAtom as __sideRegistryAtom}'
    'from"./app-initial-feb30b196d11.js";\n'
)


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
    source = {}
    for name, digest in ASSETS.items():
        original = read_file(archive, "webview/assets/" + name)
        if sha256_bytes(original) != digest:
            raise ValueError("Unknown original asset: " + name)
        source[name] = original.decode("utf-8")

    name = "local-conversation-side-chat-96a703d918a9.js"
    text = replace_between(
        source[name], "async function zt(", "function Bt(",
        (ROOT / "hooks/local-create.js").read_text(),
    )
    # A local native fork must be cancelled if its original loading tab has been retired.
    text = replace_once(
        text,
        "instructionOverrides:Re(e.get(Te),e.get(we,i)??c?.settings.model??null),parentNavigationPath:",
        "assertRequestCurrent:()=>{if(!k.isCurrent())throw Error(`Side chat creation cancelled`);},"
        "instructionOverrides:Re(e.get(Te),e.get(we,i)??c?.settings.model??null),parentNavigationPath:",
    )
    # Cancellation archives the actual saved thread and then removes only the provisional relation.
    text = replace_once(
        text,
        "b??await H(e,t.hostId).archiveConversation(t.conversationId,"
        "{useAppServerPins:!1,source:`side-chat-cancelled`});return",
        "if(b==null){"
        "const p={conversationId:t.conversationId,options:"
        "{useAppServerPins:!1,source:`side-chat-cancelled`}};"
        "await __scp.loggedRpc(`archiveConversation`,p,()=>"
        "H(e,t.hostId).archiveConversation(t.conversationId,p.options));"
        "if(t.hostId===`local`)__scp.forgetCancelled(__sideStorage(),t.conversationId);}"
        "return",
    )
    # Recheck after creation/resume and after caller preparation before completing a native panel.
    identity_check = (
        "__scp.assertIdentity(j.durable,e.get(__sideAccount),e.get(__sideUser))"
    )
    text = replace_once(
        text,
        "if(!k.isCurrent())return await A(j),null;",
        "if(!k.isCurrent())return await A(j),null;" + identity_check + ";",
    )
    text = replace_once(
        text,
        "if(M==null&&h!=null&&await h(t),!k.isCurrent())",
        "if(M==null&&h!=null&&await h(t)," + identity_check + ",!k.isCurrent())",
    )
    # Persist the final title before complete() triggers renderer subscriptions and layout saving.
    text = replace_once(
        text,
        "let{conversationId:s,hostId:u}=r;E!=null",
        "let{conversationId:s,hostId:u}=r;"
        "if(r.durable?.hostId===`local`)"
        "__scp.remember(__sideStorage(),{...r.durable,title:T});E!=null",
    )
    # Normal close already avoids native deletion for durable threads. Preserve its discovery row.
    text = replace_once(
        text,
        "(r.durable==null||fe(e,g)==null)&&(m?.(),Ce(e,i,s),f?.(!0))",
        "(r.durable==null||fe(e,g)==null)&&("
        "r.durable?.hostId===`local`&&__scp.hide(__sideStorage(),s),"
        "m?.(),Ce(e,i,s),f?.(!0))",
    )
    source[name] = IMPORT + SIDE_IMPORT + text

    name = "persistent-e62eb8d90af6.js"
    source[name] = IMPORT + replace_between(
        source[name], "async function H(", "function U(",
        (ROOT / "hooks/restore.js").read_text(),
    )

    name = "app-initial-feb30b196d11.js"
    text = source[name]
    # Qw is the frontend presentation merge; native server history and Zw remain unmodified.
    text = replace_once(
        text,
        "function Qw(e,t){let n=Zw(e);return e.turnHistory?.kind===`canonical`?"
        "Xc(n,e.turns,{policy:t}):n}",
        "function Qw(e,t){let n=Zw(e);return __scp.displayTurns(codexSidePatchStorage(),e,"
        "e.turnHistory?.kind===`canonical`?Xc(n,e.turns,{policy:t}):n)}",
    )
    # Unified timeline selectors read canonical entities directly and bypass Qw.
    text = replace_once(
        text,
        "return Cro({conversationRequests:a,isAeonThread:o,",
        "return Cro(__scp.presentationOptions(codexSidePatchStorage(),"
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
        "let _=await o.sendRequest(`thread/fork`,n,f),v=cs(_.thread.id)",
        "let _=await(c.sideConversation&&r===`default`?"
        "__scp.loggedRpc(`thread/fork`,n,()=>o.sendRequest(`thread/fork`,n,f)):"
        "o.sendRequest(`thread/fork`,n,f)),v=cs(_.thread.id)",
    )
    text += """
/** Reuse one native KV adapter across hot selectors; reads still fetch the latest native snapshot. */
var __codexSideStorage;
/** Lazily bind existing persistent KV functions after native initialization, without new I/O. */
export function codexSidePatchStorage(){
  return __codexSideStorage??=({readValue:_v,writeValue:vv});
}
/** Lazily initialized native KV atom makes saved and hidden rows reactive across windows. */
var __codexSideRegistryAtom;
/** Resolve the registry signal only after the application's signal runtime is initialized. */
export function codexSidePatchRegistryAtom(){
  return __codexSideRegistryAtom??=(Ev(()=>__scp.REGISTRY_KEY,null));
}
"""
    source[name] = IMPORT + text

    name = "local-conversation-thread-f8411a03e6c2.js"
    text = source[name]
    # Reuse the original summary section instead of creating an independent recovery UI.
    text = replace_once(
        text,
        "bO=w(_i,({get:e})=>mO(e(Vo.tabs$),t=>e(su,t)??!1))",
        "bO=w(_i," + (ROOT / "hooks/summary.js").read_text().strip() + ")",
    )
    text = replace_once(
        text,
        "r=e=>{Aa(t,`right`,e.tabId)}",
        "r=e=>{if(e.durable){"
        "lg(t,NF,{durable:e.durable,sourceConversationId:e.durable.sourceConversationId,"
        "hostId:e.durable.hostId,cwd:null,collaborationMode:e.durable.collaborationMode,"
        "displayTitle:e.title,intl:t.get(__sideIntl),target:`right`})"
        ".catch(error=>t.get(Fe).danger(error.message));"
        "}else Aa(t,`right`,e.tabId)}",
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
    result = {"webview/assets/" + name: value.encode() for name, value in source.items()}
    result[RUNTIME_PATH] = (ROOT / "runtime/persistence.mjs").read_bytes()
    return result


def implementation_digest():
    """Pin templates, adapter and signing policy so a stale or unlaunchable package gets rebuilt."""
    files = [
        ROOT / "patchkit/profile.py", ROOT / "runtime/persistence.mjs",
        ROOT / "hooks/local-create.js", ROOT / "hooks/restore.js", ROOT / "hooks/summary.js",
        ROOT / "patchkit/manager.py", ROOT / "patchkit/integrity.py",
    ]
    return sha256_bytes(b"".join(path.read_bytes() for path in files))

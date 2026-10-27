# Codex 侧边聊天永久删除技术方案

更新日期：2026-10-27。状态：删除清理修复版本已安装并重新启动；26 项运行时行为检查、32 项安装流程检查及真实原包函数集成检查通过。用户已确认删除的侧边完成索引和布局收尾，重启后不再恢复；主会话和其余 6 条侧边记录保留。

## 1. 功能与入口

在主会话的 **Side chats** 列表中，每条已保存本地侧边增加操作菜单，菜单提供“永久删除”。已打开和已关闭的侧边都使用这个入口。

| 操作 | 行为 |
| --- | --- |
| 点击侧边标签的 × | 收起面板，保留聊天记录，后续可重新打开 |
| 点击“永久删除” | 确认后删除目标原生线程，并清理侧边关联、标签布局和缓存 |

确认框展示侧边标题，说明“此侧边聊天及其子代理聊天将永久删除，无法撤销；正在进行的回复也会停止”。按钮为“取消”和“永久删除”，默认聚焦取消。提交后显示加载状态，阻止重复提交；失败时保留确认框并允许重试。

列表操作按钮与打开聊天的按钮分开，避免嵌套按钮和点击删除时触发重新打开。本次面向关联索引中已登记的 `local` 持久侧边。

操作菜单使用应用原生下拉菜单及默认 Portal，让弹层展示到摘要分区外，避免固定面板的 `overflow-hidden` 裁剪。定位、键盘导航和外部点击关闭由原生组件处理。只在选择删除、打开确认框时阻止菜单恢复触发按钮焦点，保留确认框默认的“取消”焦点。

入口实现：[列表菜单与确认框](source://codex-side-chat-patch/hooks/side-list.js:0)、[原生弹层菜单](source://codex-side-chat-patch/hooks/side-list.js:2221)、[Side chats 信号](source://codex-side-chat-patch/hooks/summary.js:466)、[隐藏记录](source://codex-side-chat-patch/runtime/persistence.mjs:6390)。

## 2. 原生删除接口

采用主会话删除确认框使用的原生 RPC：

```json
{
  "method": "thread/delete",
  "params": {
    "threadId": "目标侧边的原生线程 ID"
  }
}
```

通过当前本地 host 管理器的 `sendRequest` 调用。线程 ID 从重新读取并校验后的侧边关联记录取得，发起前检查 host、账户、用户和来源主会话，并确认目标 ID 与主会话 ID 不同。

接口成功结果是 `{}`，同时产生 `thread/deleted` 通知。调用方按提交时捕获的线程 ID 完成清理，通知用于同步其他窗口及处理从原生入口发生的删除。两条完成路径使用同一套幂等清理逻辑。

删除范围沿用原生线程及其子代理的语义。主会话、同级侧边和工作目录文件不作为补丁清理对象。新接入的 RPC 使用现有 `loggedRpc`，发起前登记 finally 日志，忠实记录 JSON 入参、完整返回值及错误字段。

接口依据：[主会话删除确认框](source://CodexSideChatEvidence/source/webview/assets/delete-thread-dialog-7a9e7f1312fd.js:0)、[原生删除通知接口](source://CodexSideChatEvidence/source/webview/assets/app-initial-feb30b196d11.js:4182243)、[原生缓存清理](source://CodexSideChatEvidence/source/webview/assets/app-initial-feb30b196d11.js:5192517)、[完整 RPC 日志](source://codex-side-chat-patch/runtime/persistence.mjs:13655)。

## 3. 删除顺序与恢复保护

在现有 `codex-native-side-chats-v1` 记录上增加可选 `deletion` 字段，保存操作 ID 和阶段：`requested` 表示用户已确认、原生结果尚待确认；`native-deleted` 表示正文删除已确认、本地收尾尚待完成。已有无该字段的记录按正常侧边读取。

删除状态写入等待主进程对请求 ID 和操作 ID 的确认。渲染端通过已有 KV 发布通道提交单条变更，不乐观替换整份索引；主进程串行合并并等待原生 `flushOrThrow`，成功广播新索引后才回传确认。标题和隐藏更新不会覆盖删除标记，失败撤销核对操作 ID。

完成删除时，主进程统一过滤持久布局并移除关联记录；另存已删除线程 UUID，阻止旧快照、旧恢复和迟到的布局发布重建记录。只保存 UUID，不复制正文。最终移除或失败撤销落盘失败时，内存保留此前的删除标记，供直接重试。普通布局保存按快照缓存 UUID 集合，只检查当前布局中的标签。

存储依据：[渲染端 KV 发布](source://CodexSideChatEvidence/source/webview/assets/app-initial-feb30b196d11.js:3250508)、[主进程 KV 更新](source://CodexSideChatEvidence/source/.vite/build/main-0FVbxCQU.js:4477519)、[主进程更新回传](source://CodexSideChatEvidence/source/.vite/build/main-0FVbxCQU.js:4478295)。

执行顺序：

1. **确认并登记。** 校验最新记录后写入 `requested`，等待主进程确认，再发送 RPC。该侧边显示删除状态，禁止重新打开、发送新消息或重复提交删除。
2. **原生删除。** 调用 `thread/delete`。原生成功响应或对应删除通知将记录推进到 `native-deleted`。生成中的回复由原生删除流程终止。
3. **关闭已删除的标签。** 按目标线程 ID 关闭当前窗口所有匹配的侧边标签，其他窗口通过删除事件及原生 KV 信号完成同样处理。删除清理绕过普通关闭回调中的语音停止失败、标签重建等恢复分支，并禁止写入撤销关闭记录。
4. **清理持久布局。** 使用原生布局过滤函数移除该侧边的路由，同时更新右侧、底部面板的标签集合、活动标签及焦点。同步移除主会话内存中的该侧边关联，保留其他标签。
5. **完成收尾。** 布局清理成功后移除关联索引记录，释放目标侧边的展示缓存，最后显示“侧边聊天已永久删除”。若布局或 KV 写入失败，保留 `native-deleted` 状态以重试收尾。

主会话内存关联复用原生 `JEn(scope, parentId, childId)`，由它更新 `ND` 信号族；`FD` 是初始化函数，不能作为信号传入 `scope.set`。依据：[标签及关联清理](source://codex-side-chat-patch/hooks/delete-adapter.js:378)、[原生关联删除](source://CodexSideChatEvidence/source/webview/assets/app-initial-feb30b196d11.js:5411698)。

恢复入口在每个异步边界及最终接纳标签前，重新检查记录仍存在且没有删除状态。`remember` 必须拒绝覆盖正在删除的记录；恢复旧描述时必须要求原记录存在。这样，已经开始的恢复请求不会在删除后重新创建标签或关联。

已在等待语音停止的普通关闭回调，在尝试重建标签前也重新检查记录。展示缓存记录线程 UUID 的弱关联，删除时释放该 UUID 在不同 IPC 快照中留下的有界缓存条目。

复用依据：[索引读取](source://codex-side-chat-patch/runtime/persistence.mjs:2220)、[索引写入](source://codex-side-chat-patch/runtime/persistence.mjs:5049)、[恢复检查点](source://codex-side-chat-patch/hooks/restore.js:183)、[最终接纳检查点](source://codex-side-chat-patch/patchkit/profile.py:5221)、[原生关闭回调](source://CodexSideChatEvidence/source/webview/assets/local-conversation-side-chat-96a703d918a9.js:41121)、[原生布局过滤](source://CodexSideChatEvidence/source/webview/assets/app-initial-feb30b196d11.js:8318480)。

## 4. 失败、重试与跨窗口

| 情况 | 处理 |
| --- | --- |
| 用户取消确认 | 不写删除状态，不发送删除请求 |
| RPC 明确失败且没有删除完成证据 | 清除本次请求状态，保留记录并提示重试 |
| 连接中断、结果不明或应用退出 | 保留 `requested`；匹配账户下，连接恢复或主会话再次打开时继续确认和重试 |
| 正文已删、本地清理失败 | 保留 `native-deleted`，只重试标签、布局及索引收尾 |
| 原生已经删除，重复请求返回找不到 rollout | 仅识别固定版本明确的目标线程不存在错误后完成收尾；其他错误不能当成删除成功 |
| 其他窗口或原生入口删除同一线程 | 本地 host 的删除监听按准确线程 ID 调用同一收尾函数 |

每个本地 host 管理器注册一次删除监听，并随管理器释放。打开的侧边标签与已挂载主会话列表均注册布局清理回调，摘要面板收起后仍能清理打开的侧边。后台恢复仅处理用户已确认的未完成删除，继续核对账户身份；采用已有连接和页面事件触发，不增加常驻服务或定时轮询。

## 5. 改动点与验证

实施分支为 `feat/permanent-side-chat-delete`，基于已安装的 `feat/minimal-side-chat-overhead` 优化版本，保留快照校验、分组索引和有界缓存。基线已核对安装 receipt；代码未提交。

| 改动位置 | 内容 |
| --- | --- |
| [运行时辅助模块](source://codex-side-chat-patch/runtime/persistence.mjs:2220) | 删除状态校验、操作去重、索引收尾、恢复保护及目标缓存释放 |
| [摘要列表 hook](source://codex-side-chat-patch/hooks/summary.js:466) | 为打开和关闭条目统一补充可删除身份、删除状态与禁用状态 |
| [恢复 hook](source://codex-side-chat-patch/hooks/restore.js:183) | 增加记录存在性和删除状态检查 |
| [删除交互 hook](source://codex-side-chat-patch/hooks/side-list.js:0) | 原生 Portal 菜单、弹窗基础组件、取消默认焦点、提交去重及失败重试 |
| [原生标签接入](source://codex-side-chat-patch/hooks/delete-adapter.js:0) | 删除监听、打开标签注册、布局过滤及关闭回调绕过 |
| [主进程 KV 协同](source://codex-side-chat-patch/runtime/main-state.cjs:0) | 删除状态写入确认、并发索引合并、失败标记保留及旧快照覆盖保护 |
| [版本适配器](source://codex-side-chat-patch/patchkit/profile.py:614) | 纳入原生摘要组件、共享界面资源和主进程接入的固定哈希与唯一锚点；接入菜单、删除监听和布局过滤，并将新增 hook 纳入实现指纹 |

新增方法及字段补充明确注释。补丁继续由现有副本生成、摘要校验、固定证书签名和安装流程交付。

本次已用应用内置 `codex-cli 0.164.0-alpha.11.1` 在独立 `CODEX_HOME`、空工作目录和本机固定响应中验证：

- 直接删除已保存侧边成功，返回 `{}` 并产生 `thread/deleted`。
- 目标 rollout 文件被移除，重启后无法恢复该线程。
- 主会话与同级侧边的 rollout 保留，重启后可继续恢复。
- 未在当前引擎加载的已关闭侧边，可直接删除。
- 生成中的侧边可直接删除，目标 rollout 被移除。
- 重复删除返回明确的 `no rollout found for thread id …` 错误。

隔离证据位于 `/tmp/codex-side-delete-probe-37jyyz9_/`，包括完整 RPC JSON 日志、`results.json` 和 `additional-results.json`。实验只处理合成会话。

已通过 26 项 Node 行为检查和 32 项 Python 安装流程检查。检查直接执行删除运行时、主进程协同、实际恢复 hook、原生菜单、确认框与标签清理 hook，覆盖菜单选择与关闭时的焦点交接、取消、重复提交、失败重试、删除与恢复并发、落盘失败、跨窗口通知、磁盘状态重载、父会话和同级保护。检查使用合成线程及仓库外状态文件。

原包集成检查执行生成后的删除 hook 与真实 `JEn`、`OOi`、`kOi`、`WEn` 函数，验证目标标签、关联和布局清理、父会话与同级保护、空关联、缺失布局及重复执行。错误地传入 `FD` 的对照必须失败，避免用虚构信号的夹具掩盖实际调用错误。证据位于独立 `CodexSideChatEvidence/verification/native-cleanup-integration.json`。

固定版本原包生成的 8 份变更资源通过唯一锚点、哈希和 Node 语法检查；21 个新增界面导入绑定与真实导出一致，共享原生界面资源另行固定完整哈希。签名副本通过 ASAR、Electron 框架元数据及完整包签名校验，使用已有固定证书 `659A2CD838DF7ADCB88F313BDE6572A223C4923C`。

副本位于 `~/Library/Application Support/CodexSideChatPatch/stages/5697f050d30261e3d24f68471db501e16a2dbba9516022722726def8612c3847`，已纳入现有启动器缓存；实现指纹为 `7d5e403c92cc63935e2b0d0c3f8d15bbfd4f06d10e13f89835b8e49f3a98f5cc`。已通过现有 `launch` 流程升级。当前 `/Applications/ChatGPT.app` 为 `patched` 且正在运行，ASAR 摘要为 `da429d27ba5666f77ae6d0832377dec285f603e6b0c2d712139102d7d4cb4048`，安装事务为 `committed`。完整原厂回滚包位于 `/Applications/.codex-side-patch-48dee6_h/ChatGPT.app`。

“工单agent_知识侧”的固定摘要面板已通过原生菜单、确认框和默认取消焦点验收。用户已确认删除的目标，其原生 `thread/delete` 已成功且 rollout 不存在；本次通过“重试永久删除”只完成 `native-deleted` 的本地收尾，没有再次发送删除 RPC。界面显示成功通知，目标关联与布局均已清除，主会话 rollout 和其余 6 条侧边记录保留，其他记录内容哈希不变。正常退出并重启后，目标仍不在列表和布局中。实际状态证据位于独立 `CodexSideChatEvidence/verification/delete-repair-completed.json`。新建、已关闭和生成中侧边首次删除的桌面场景仍待分别验收。

源码链接采用 GoLand 内容根 `codex-side-chat-patch` 与已有独立证据内容根 `CodexSideChatEvidence`。偏移按统一 LF 后的 UTF-16 编码单元计算至目标行行首，从 0 开始。新增原生确认框证据保留原包格式；其余既有证据沿用原格式化快照。

# Codex 侧边聊天永久删除技术方案

更新日期：2026-11-04。适配版本：Codex `26.1029.61003`，build `24614`。

## 1. 最终架构结论

build 24614 已把渲染层迁移到 Rspack，并提供原生持久 Side Chat 创建/恢复模块。该创建模块要求首轮输入，而现有菜单仍先打开空侧边，因此不能直接替换现有入口。

当前方案复用新版原生 descriptor、恢复、KV、面板控制器、关系和布局 API，只保留以下补丁职责：

1. 将本地空侧边分叉改为持久线程，并登记历史兼容 registry。
2. 过滤分叉继承轮次的界面展示，不修改原生上下文。
3. 为已关闭历史侧边提供发现、恢复和标题同步。
4. 提供带归属校验、落盘确认和防陈旧恢复的永久删除事务。

旧版跨 Vite asset 的导入、导出别名注入已移除。后续每次 Codex 更新都必须重新检查原生能力，再决定保留、收缩或移除补丁层，不能只更新版本、哈希或压缩符号。

实现依据：[本地持久创建](source://codex-side-chat-patch/hooks/local-create.js:270)、[原生恢复守卫](source://codex-side-chat-patch/hooks/restore.js:198)、[Rspack 版本适配](source://codex-side-chat-patch/patchkit/profile.py:3045)。

## 2. 用户入口与语义

主会话的 **Side chats** 列表同时展示原生发现条目和兼容 registry 条目。普通关闭只隐藏面板并保留线程；行菜单中的“删除”打开永久删除确认框。

确认框明确说明侧边聊天及其子代理聊天会永久删除。默认焦点为“取消”；提交后阻止重复提交，失败时保留错误和重试入口。

列表与确认框继续使用 Codex 原生列表、菜单、对话框和按钮组件，不维护独立 UI 框架。

实现依据：[列表与菜单](source://codex-side-chat-patch/hooks/side-list.js:279)、[删除确认框](source://codex-side-chat-patch/hooks/side-list.js:3323)、[摘要合并](source://codex-side-chat-patch/hooks/summary.js:196)。

## 3. 删除接口与日志

永久删除调用当前本地 host 管理器的原生 RPC：

```json
{
  "method": "thread/delete",
  "params": {
    "threadId": "目标侧边原生线程 ID"
  }
}
```

发送前重新读取记录并校验账户、用户、来源主会话、host 和目标线程 ID；主会话 ID 不允许作为删除目标。新接入 RPC 通过统一 finally 日志记录忠实 JSON 入参、返回值和完整错误字段。

实现依据：[删除入口绑定](source://codex-side-chat-patch/hooks/delete-adapter.js:3476)、[删除事务](source://codex-side-chat-patch/runtime/persistence.mjs:21736)、[完整 RPC 日志](source://codex-side-chat-patch/runtime/persistence.mjs:16145)。

## 4. 删除状态机

registry 记录的可选 `deletion` 字段只有两个阶段：

| 阶段 | 含义 |
| --- | --- |
| `requested` | 用户已确认，原生删除结果尚未确认 |
| `native-deleted` | 原生正文已删除，本地标签、布局或索引仍待收尾 |

执行顺序：

1. 主进程串行登记 `requested` 并确认落盘，之后才允许发送 `thread/delete`。
2. 原生成功响应、对应删除通知或固定版本明确的目标 rollout 不存在错误，将状态推进到 `native-deleted`。
3. 关闭当前窗口内所有目标标签，绕过普通关闭的语音恢复、标签重建和撤销记录。
4. 使用 `Exwq.V1` 清理持久布局，使用核心 `Ioto.ux` 删除父子关系。
5. 清理完成后移除 registry 记录；已删除 UUID tombstone 阻止旧布局和迟到恢复重建目标。

主进程不会乐观覆盖整份 registry。每次变更按请求 ID 和操作 ID 合并，等待原生存储 flush 后才回传确认。

实现依据：[渲染端原子变更](source://codex-side-chat-patch/runtime/persistence.mjs:18554)、[主进程合并](source://codex-side-chat-patch/runtime/main-state.cjs:12722)、[布局过滤](source://codex-side-chat-patch/runtime/main-state.cjs:2864)、[标签与关系清理](source://codex-side-chat-patch/hooks/delete-adapter.js:375)。

## 5. 恢复与并发保护

恢复、发送新消息和标签最终接纳都重新检查：

- descriptor 属于当前账户和用户；
- registry 中仍存在同一来源主会话和 host 的记录；
- 记录没有删除状态；
- 已删除 UUID tombstone 不包含目标线程。

新建 descriptor 带 `patchVersion: 1`。历史 descriptor 通过 registry 或 tombstone 识别，避免已完成删除后由旧布局恢复。删除期间的 `turn/start`、`turn/steer`、`thread/resume`、队列写入和 follower 请求均被拒绝。

实现依据：[历史 descriptor 识别](source://codex-side-chat-patch/runtime/persistence.mjs:9763)、[恢复守卫](source://codex-side-chat-patch/hooks/restore.js:198)、[请求守卫](source://codex-side-chat-patch/runtime/persistence.mjs:27963)。

## 6. 失败与重试

| 情况 | 处理 |
| --- | --- |
| 用户取消 | 不写删除状态，不发送 RPC |
| RPC 明确失败且无删除证据 | 撤销本次 `requested`，保留记录 |
| 连接中断或结果不明 | 保留 `requested`，连接恢复或主会话重新挂载时继续 |
| 原生已删但本地收尾失败 | 保留 `native-deleted`，重试时不再次发送删除 RPC |
| 其他窗口或原生入口删除 | 删除通知按准确线程 ID 进入同一收尾流程 |

每个本地 host 管理器只注册一次删除监听，并随管理器释放。恢复由已有连接和挂载事件驱动，不增加轮询、定时器或常驻进程。

## 7. 验证结论

- 34 个 Node 行为用例通过，覆盖创建、恢复、命名、删除并发、落盘失败、跨窗口通知和陈旧恢复。
- 32 个 Python 安装事务用例通过。
- `codex-cli 0.166.0-alpha.6` 隔离协议检查通过：持久分叉、无正文边界分页、重启原 ID、多轮上下文、父会话后续轮次隔离和临时线程语义均符合预期。
- 5 个 Rspack chunk、1 个主进程资源和 2 个运行时模块通过精确哈希、唯一锚点、Node 语法、Acorn 语法与作用域检查。
- 固定证书签名副本和已安装应用通过 ASAR、Electron 框架元数据、完整包深度签名及安装收据校验。
- 当前 `/Applications/ChatGPT.app` 已正常启动；界面和功能验收由用户完成。

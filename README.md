# Codex 原生侧边聊天持久化补丁

让补丁启用后新建的**本地侧边聊天**使用 Codex 原生持久线程，并通过原侧边面板恢复。正文由 Codex 保存；补丁只额外保存主会话关联、标题、账户身份和继承轮次 ID。

完整 Git 仓库位于 `/Users/bytedance/projects/codex-side-chat-patch`，可以直接用 GoLand 打开这个目录。

实现位于 `feat/persistent-side-chats` 分支。2026-10-26 已使用已有固定证书安装到 `/Applications/ChatGPT.app` 并重新打开，**实际聊天和工作界面加载通过、原登录状态可用；侧边持久化交互仍待用户验收**。完整原厂应用已保留，支持回滚。

## 官方授权与账号风险

截至 2026-10-26，没有查到 OpenAI 对此类官方桌面应用补丁的明确授权。公开[个人使用条款](https://openai.com/policies/terms-of-use/)把关联软件纳入 Services，禁止修改 Services，并限制逆向工程；违反条款可导致暂停或终止账号。[企业服务协议](https://openai.com/policies/services-agreement/)同样限制逆向工程。具体适用范围以账号协议和适用法律为准。

本项目修改官方应用的 `app.asar` 及框架中的完整性元数据，不能因为只改本地保存逻辑、保留原生权限检查或通过签名校验，就宣称官方允许或不会封号。没有可核实数据用于估计单纯本地补丁的封禁概率；公开社区项目也不构成官方授权。此次安装按用户明确要求执行，上述协议约束仍然适用。

OpenAI 明确提供[开源 Codex 组件](https://developers.openai.com/codex/open-source/)和用于自建客户端的 [App Server](https://developers.openai.com/codex/app-server/)。Codex CLI 仓库采用 Apache-2.0 许可证，允许在许可证条件下修改该开源代码；这不等于授权修改官方桌面外壳。使用 OpenAI 在线服务仍须遵守服务条款。

## 如何生效

Codex 的本地引擎已经支持持久线程，但原侧边创建走临时模式，而且没有持久标签描述。本补丁同时处理正文保存和面板恢复：

1. 本地侧边仍从主会话原生分叉，把创建参数改为 `ephemeral: false`，使引擎保存正文并持续追加新轮次。
2. 保存侧边线程 ID、来源主会话、账户身份和标题。重开主会话时，原布局或 Side chats 列表据此调用原生恢复接口，打开同一个侧边线程。
3. 面板只展示侧边自己的问答；继承的主会话上下文仍由引擎保留。关闭面板表示隐藏，关联不会被删除。

`codex_side_patch.py` 是补丁管理入口。`stage` 复制完整原应用，在副本的 `app.asar` 中替换四处 JavaScript 资源并增加辅助模块，更新文件/分块、ASAR 头、plist 和框架中的元数据摘要后重签；`apply` 将已验证的完整副本安装到原应用路径，同时保留完整原包。框架适配保留启用标志、版本和 ASAR 完整性校验。保存及恢复逻辑由应用内部执行。另有独立双击启动入口，在打开原应用前检查并重新应用补丁。

当前在用应用已经使用固定本地证书重签。原厂备份路径记录在 `~/Library/Application Support/CodexSideChatPatch/installation.json` 的 `backup` 字段；本次最终安装的完整原包位于 `/Applications/.codex-side-patch-5t1tu11k/ChatGPT.app`。补丁运行时不需要常驻 Python 进程。

## 支持范围

| 项目 | 固定值 |
| --- | --- |
| 应用路径（默认） | `/Applications/ChatGPT.app` |
| Bundle ID | `com.openai.codex` |
| 应用版本 / build | `26.1021.31345` / `21828` |
| 内置引擎 | `codex-cli 0.164.0-alpha.11.1` |
| 原始 ASAR SHA-256 | `130145706a912db74e4d260ad7538f10f1e05e88af955f9afba42cdf01e64606` |

工具还核对四个目标资源的完整哈希及唯一锚点。手动命令默认严格匹配上述版本和完整 ASAR。自动启动使用兼容尝试：更新包只有原厂完整签名、ASAR 完整性、四处目标资源、内置引擎版本及已适配的 ARM64 框架摘要结构仍匹配才会应用；未知框架路径或结构需要单独适配。

环境要求：macOS、Python 3.9+、Node.js；不需要安装 Python 或 npm 依赖。所有副本、状态、日志和实验数据必须在本仓库外。

## 使用

在本仓库目录执行。先检查安装状态；这不会退出或修改原应用：

```sh
cd /Users/bytedance/projects/codex-side-chat-patch
python3 -B codex_side_patch.py status
```

需要构造新副本时，源包必须是已验证的原厂应用，可先回滚当前补丁。检查 JS 语法、ASAR 摘要、Electron 完整性信息和完整包签名：

```sh
python3 -B codex_side_patch.py stage --output /tmp/codex-side-stage-check
python3 -B codex_side_patch.py verify /tmp/codex-side-stage-check
```

默认使用 ad-hoc 签名，仅供隔离检查，`apply` 会拒绝安装。输出目录必须是新目录。

准备安装时，使用已有的固定代码签名证书。先查询证书 SHA-1：

```sh
security find-identity -v -p codesigning
```

把下面的证书 SHA-1 替换为查询结果中的 40 位值。工具会核对实际签名叶证书和这个值，而不只是核对记录：

```sh
CODEX_SIDE_SIGNER="填入已有固定证书的40位SHA1"
CODEX_SIDE_STAGE="$HOME/Library/Application Support/CodexSideChatPatch/stages/build-21828"
python3 -B codex_side_patch.py stage --identity "$CODEX_SIDE_SIGNER" --output "$CODEX_SIDE_STAGE"
python3 -B codex_side_patch.py verify "$CODEX_SIDE_STAGE"
```

保存正在进行的工作，手动退出 Codex 后再安装：

```sh
python3 -B codex_side_patch.py apply "$CODEX_SIDE_STAGE"
```

工具拒绝运行中替换。仅对已验证由飞书独立 MCP 进程持有的 `cua_node/bin/node_repl` 做精确所有者豁免，交换前必须核对两边运行时字节完全一致，不终止该进程。安装使用同一文件系统上的完整 `.app` 原子交换，保留包含原始签名、`Info.plist` 和资源的完整原包。重复安装当前补丁会返回 `already-patched`。

启动后，在原主会话创建新的侧边聊天。重开主会话时，已打开的标签走原生布局恢复；关闭的侧边聊天可以从主会话的 **Side chats** 列表重新打开。恢复使用原线程 ID，展示只显示侧边问答，继承的主会话历史仍保留在引擎上下文中。

## 界面变化

继续使用原来的主聊天、侧边聊天面板、标签和 **Side chats** 列表。列表补入已保存但已关闭的侧边，点击后在原侧边面板打开；已保存侧边的空状态文案说明可在重启后恢复。关闭面板表示隐藏，走原生持久标签的关闭逻辑。

独立启动器增加一个名为 **Codex Side Chats** 的入口，不替换原 Dock 图标，也不新增聊天窗口。更新后应用补丁会提示“这一版尚未完成桌面验证，可能有问题”；匹配失败会提示本次未应用。通知由 macOS 显示，是否可见取决于系统通知设置；同一版本和结果成功通知后不重复提示。

已安装后新建的本地侧边会话使用上述行为。此次只检查基础桌面启动和已有界面加载，关闭重开与重启恢复由用户进一步验收。

## 双击自动启动

生成入口本身不安装补丁，也不启动 Codex。使用入口时会自动检查并在匹配时安装；上述官方授权与桌面验收结论仍适用。

```sh
python3 -B codex_side_patch.py create-launcher \
  --identity "$CODEX_SIDE_SIGNER" \
  --output "$HOME/Applications/Codex Side Chats.app"
```

入口记录当前 Python、Node、仓库、证书和原应用的绝对路径。仓库迁移、解释器删除或证书更换后应重新生成入口。已生成的本机入口位于 `/Users/bytedance/Documents/Trae-CN/temp_20261023_01/Codex Side Chats.app`，目标仍为 `/Applications/ChatGPT.app`。此次从终端执行了相同的 `launch` 流程，完成固定证书安装及启动。

也可以从终端运行相同流程：

```sh
python3 -B codex_side_patch.py launch --identity "$CODEX_SIDE_SIGNER"
```

| 启动时的状态 | 行为 |
| --- | --- |
| 原应用已经运行 | 只聚焦；下次手动退出后再从入口启动才会应用 |
| 已安装当前补丁 | 直接打开原应用 |
| 同版本重装 | 验证并复用副本，重新应用后打开 |
| 更新版目标代码及引擎仍匹配 | 从新版原包构造副本、应用、打开，再提示版本尚未完成桌面验证 |
| 更新版目标代码、签名或引擎不匹配 | 保留当前应用、请求打开，并提示本次未应用 |
| 旧补丁实现 | 先准备当前副本，经匹配的完整原包回滚后再应用 |
| 安装中断 | 先自动恢复；存在无法核对的外部修改时停止启动 |
| 同时双击多个入口 | 一个执行，其余返回 `launch-in-progress` |

副本缓存依据版本、原 ASAR、引擎、完整原厂签名指纹、补丁实现和证书生成，安装前再次核对完整原包。签名策略和框架摘要适配也计入实现指纹。即便 ASAR 相同，其他资源更新也不会被旧缓存覆盖。启动请求后会检查主进程连续存活，单纯 `open` 成功不代表启动成功；这仍不能代替窗口和功能验收。日志位于状态目录的 `launch.jsonl`，只记录启动与安装元数据和错误，不读取聊天正文；缓存和备份不自动删除。

## 回滚、重装与更新

手动退出应用后回滚完整原包：

```sh
python3 -B codex_side_patch.py rollback
```

回滚保留会话正文、原生布局和关联索引。原包是否完整呈现补丁创建的侧边，仍需要桌面验收。

安装状态与事务日志默认位于 `~/Library/Application Support/CodexSideChatPatch/`；原包备份保存在安装目录中的 `.codex-side-patch-*` 目录。若事务期间进程异常退出，启动入口会自动尝试恢复；手动恢复使用：

```sh
python3 -B codex_side_patch.py recover
```

恢复只处理尚未提交的事务，依据两侧完整 ASAR 哈希恢复交换前状态；外部改动会使恢复停止写入。不要提前删除状态文件或完整原包备份。

同版本重装且保留用户数据后，使用启动入口即可重新应用。手动命令默认对未知新版本返回 `unknown`；`status`、`stage`、`verify` 和 `apply` 可显式加 `--try-updated-version` 使用同样的兼容检查。这个选项只放宽版本标签和完整原 ASAR 的固定值，不放宽原厂签名、目标代码、锚点或引擎要求。目标代码变化后仍须新增适配，不能把旧版本完整副本装到新版上。

```sh
python3 -B codex_side_patch.py status --try-updated-version
```

回滚使用安装记录中的实际原包哈希和签名，不会把匹配的新版本降级到 build 21828。旧实现的手动更新仍需先回滚再构造副本。

```sh
python3 -B codex_side_patch.py watch --interval 30
```

`watch` 按安装路径持续报告状态变化，用于发现更新或重装；它不自动安装补丁或退出应用。自定义安装位置、状态目录时，把 `--app`、`--state-dir` 放在子命令前面，并在后续命令中使用同一组值。

## 验证

自动化检查使用合成身份、轮次和微型应用包，不读取真实会话：

```sh
node --test tests/runtime.test.mjs
python3 -B -m unittest discover -s tests -p 'test_*.py' -v
git diff --check
```

隔离协议验证会创建新的 `CODEX_HOME` 和空工作目录，本机 HTTP/SSE 服务提供固定响应：

```sh
python3 -B tests/native_protocol_probe.py \
  --codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
  --output /tmp/codex-side-native-probe
```

该检查验证：持久分叉、无正文的继承边界分页、重启后原 ID、多轮历史及继续追问上下文、后续父轮次隔离、临时线程失效和旧临时线程迁移失败。完整 RPC 输入、输出、错误写入外部 JSON 日志，响应夹具与结果也写入指定目录。桌面应用不会被退出或重启。

当前自动化检查为 11 个 Node 用例和 32 个 Python 用例，另有上述真实引擎协议验证。启动检查使用真实微型 ASAR、完整目录复制及原子交换，覆盖缓存复用、更新匹配/拒绝、完整资源防降级、复制期间更新、旧补丁升级、并发、运行中聚焦、故障恢复和入口生成；签名服务、桌面启动和通知在这些用例中替换为夹具。实际摘要 hook 的用例覆盖原生 KV 信号族的参数协议；真实桌面的摘要面板已正常显示。外部微型 Mach-O 夹具验证摘要同步只改 32 字节，并拒绝旧摘要错误、重复槽、禁用标志、未知格式和篡改。实际安装包及完整原厂备份通过严格签名和两层 Electron 元数据校验，实际窗口已打开，聊天和工作界面可加载。

用户可新建本地侧边聊天、关闭后从主会话 Side chats 重开，再正常退出并重启后继续追问。原侧边入口、标签恢复及重签后的重新登录、钥匙串和实际系统权限仍需完整验收。工具、图片、附件、超长历史、压缩和生成中强制退出尚未完成桌面验证。

## 数据与限制

- 第一版处理新建本地侧边；云端和远程 host 保持原行为。
- 已存在的临时侧边没有原生 rollout；当前协议无法按原 ID 把它转成持久线程。本补丁不迁移旧临时侧边。
- 关联索引使用原生 KV 键 `codex-native-side-chats-v1`，布局使用原生 `thread-tab-routes-v1:`。索引不存正文。
- 同版本重装保留用户数据时可以重新应用补丁；删除用户数据也会删除正文及索引。
- 修改包需要重新签名。固定本地证书不能继承 OpenAI 的 Team 权限；安装去除厂商绑定的钥匙串、应用组、APS 与通信通知 entitlement，保留 JIT，并仅为此应用增加 `disable-library-validation` 以兼容没有厂商 Team ID 的本地签名。未修改系统全局安全设置。原厂推送和相关 Team 功能不能视为已兼容，重新登录及权限仍需验收。
- 补丁只接入保存、发现和恢复，继续使用原侧边上下文说明及原生权限检查。

## 文件

- `patchkit/profile.py`：精确版本适配与局部资源替换。
- `hooks/`：本地持久创建、原生恢复及摘要列表信号适配。
- `runtime/persistence.mjs`：原生 KV 索引、展示边界、账户检查与完整 RPC JSON 日志。
- `patchkit/archive.py`：ASAR 读取、摘要验证和重建。
- `patchkit/integrity.py`：保留完整性校验的 ARM64 框架元数据摘要适配。
- `patchkit/manager.py`：副本生成、签名核对、安装、回滚、中断恢复与状态监测。
- `patchkit/launcher.py`：独立入口生成、启动前检查与重新应用、完整原包缓存及版本通知。
- `tests/`：合成行为检查和可独立运行的真实协议验证。

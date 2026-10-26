# Codex 原生侧边聊天持久化补丁

让补丁启用后新建的**本地侧边聊天**使用 Codex 原生持久线程，并通过原侧边面板恢复。正文由 Codex 保存；补丁只额外保存主会话关联、标题、账户身份和继承轮次 ID。

实现位于 `feat/persistent-side-chats` 分支。当前已经完成自动化与隔离引擎验证，**尚未安装到正在使用的应用，桌面运行验收待完成**。

## 支持范围

| 项目 | 固定值 |
| --- | --- |
| 应用路径（默认） | `/Applications/ChatGPT.app` |
| Bundle ID | `com.openai.codex` |
| 应用版本 / build | `26.1021.31345` / `21828` |
| 内置引擎 | `codex-cli 0.164.0-alpha.11.1` |
| 原始 ASAR SHA-256 | `130145706a912db74e4d260ad7538f10f1e05e88af955f9afba42cdf01e64606` |

工具还核对四个目标资源的完整哈希及唯一锚点。同版本的重新打包、未知版本和其他补丁不会被直接覆盖。

环境要求：macOS、Python 3.9+、Node.js；不需要安装 Python 或 npm 依赖。所有副本、状态、日志和实验数据必须在本仓库外。

## 使用

在本仓库目录执行。先检查安装状态；这不会退出或修改原应用：

```sh
python3 -B codex_side_patch.py status
```

先构造独立副本，检查 JS 语法、ASAR 摘要、Electron 完整性信息和完整包签名：

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

工具拒绝运行中替换。安装使用同一文件系统上的完整 `.app` 原子交换，保留包含原始签名、`Info.plist` 和资源的完整原包。重复安装当前补丁会返回 `already-patched`。

启动后，在原主会话创建新的侧边聊天。重开主会话时，已打开的标签走原生布局恢复；关闭的侧边聊天可以从主会话的 **Side chats** 列表重新打开。恢复使用原线程 ID，展示只显示侧边问答，继承的主会话历史仍保留在引擎上下文中。

## 回滚、重装与更新

手动退出应用后回滚完整原包：

```sh
python3 -B codex_side_patch.py rollback
```

回滚保留会话正文、原生布局和关联索引。原包是否完整呈现补丁创建的侧边，仍需要桌面验收。

安装状态与事务日志默认位于 `~/Library/Application Support/CodexSideChatPatch/`；原包备份保存在安装目录中的 `.codex-side-patch-*` 目录。若事务期间进程异常退出，先执行：

```sh
python3 -B codex_side_patch.py recover
```

恢复只处理尚未提交的事务，依据两侧完整 ASAR 哈希恢复交换前状态；外部改动会使恢复停止写入。不要提前删除状态文件或完整原包备份。

同版本重装且保留用户数据后，可以对验证过的固定证书副本再次执行 `apply`。未知新版本会返回 `unknown` 并拒绝覆盖；需要新增版本适配。旧补丁版本也不会被直接覆盖，应先回滚再构造新副本。

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

当前自动化检查为 10 个 Node 用例和 8 个 Python 用例，另有上述真实引擎协议验证。安装后仍需验收原侧边入口、标签恢复、关闭再打开，以及重签后的登录、钥匙串和实际使用的系统权限。工具、图片、附件、超长历史、压缩和生成中强制退出尚未完成桌面验证。

## 数据与限制

- 第一版处理新建本地侧边；云端和远程 host 保持原行为。
- 已存在的临时侧边没有原生 rollout；当前协议无法按原 ID 把它转成持久线程。本补丁不迁移旧临时侧边。
- 关联索引使用原生 KV 键 `codex-native-side-chats-v1`，布局使用原生 `thread-tab-routes-v1:`。索引不存正文。
- 同版本重装保留用户数据时可以重新应用补丁；删除用户数据也会删除正文及索引。
- 修改包需要重新签名。固定本地证书不能继承 OpenAI 的 Team 权限，因此首次登录及权限兼容性仍需实际验收。
- 补丁只接入保存、发现和恢复，继续使用原侧边上下文说明及原生权限检查。

## 文件

- `patchkit/profile.py`：精确版本适配与局部资源替换。
- `hooks/`：本地持久创建和原生恢复适配。
- `runtime/persistence.mjs`：原生 KV 索引、展示边界、账户检查与完整 RPC JSON 日志。
- `patchkit/archive.py`：ASAR 读取、摘要验证和重建。
- `patchkit/manager.py`：副本生成、签名核对、安装、回滚、中断恢复与状态监测。
- `tests/`：合成行为检查和可独立运行的真实协议验证。

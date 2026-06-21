# Mossbridge / 苔藓小桥

**Public Preview / self-hosted alpha。**

Mossbridge 是一个本地优先的 WeChat bridge，用来把 Codex 或 Claude Code 接入微信。它负责微信收发、文件/表情包、本地共享线程、运行态账本，以及一个由 `MOSSBRIDGE_DATA_ROOT` 管理的本地记忆层。

当前适合能读日志、会运行本地 CLI、能分清 state/data/workspace 的技术用户自托管。它还不是 Stable，也不宣称 Production Ready。

Mossbridge 从 [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss) 修改分叉而来，不是 Cyberboss 官方版本。来源与许可见 [NOTICE.md](./NOTICE.md) 和 [LICENSE](./LICENSE)。本仓库使用 `AGPL-3.0-only`。

## 当前状态

- 公开状态：self-hosted alpha / public preview。
- runtime：Codex 和 Claude Code 都是一等 runtime。
- 当前实测开发平台：macOS + Node.js 22。LaunchAgent/service 命令仅按 macOS 说明。
- 暂不宣称：跨平台 service 管理、无维护者背景的新账号 QR 首轮回复已通过、生产可用。
- 默认 state dir：`~/.mossbridge`。
- 默认 launchd label：`com.mossbridge.bridge`。

发布或演示前请先读 [docs/release-status.md](./docs/release-status.md)。

## 它是什么

Mossbridge 分成五层：

```text
WeChat mouth
  -> bridge core and tools
  -> Codex / Claude Code runtime engine
  -> local brain under MOSSBRIDGE_DATA_ROOT
  -> control plane ledger under MOSSBRIDGE_STATE_DIR
```

- **嘴**：微信 QR 登录、轮询、回复、分段、附件、表情包、桥通知。
- **手**：文件、提醒、小事记、表情包、timeline/status、记忆工具。
- **引擎**：Codex / Claude Code adapters，只放协议、session、model、approval 差异。
- **脑**：`MOSSBRIDGE_DATA_ROOT` 下的本地记忆，包括 hot context、温卡、notebook、ongoing、observation/episode、case index、conversation cache 和 cold-version compatibility。
- **控制平面**：`MOSSBRIDGE_STATE_DIR/control-events.jsonl`，记录自动动作为什么发生。

共享行为放 bridge core；只有 runtime 协议差异放 adapter。

## 要求

- Node.js `>= 22`
- 本地已登录的 `codex` 命令，或本地已登录的 `claude` 命令
- 一个能完成本地 QR 登录的微信账号
- 独立的 state/data/workspace 目录
- 只有用截图功能时才需要 Chrome / Chromium / Edge

## Clean Install

```bash
git clone https://github.com/Aryuan026/Mossbridge.git
cd Mossbridge
npm ci
test -f .env || cp .env.example .env
```

AI 部署助手请读 [docs/ai-deployment.md](./docs/ai-deployment.md)。人类快速路径见 [docs/quickstart.md](./docs/quickstart.md)。

不要覆盖已有 `.env`。不要把 clean clone 指向其他 bridge 的 state dir、live 微信账号文件或共享私人记忆仓。

## 最小配置

先创建隔离目录：

```bash
mkdir -p /tmp/mossbridge-smoke/state
mkdir -p /tmp/mossbridge-smoke/data
mkdir -p /tmp/mossbridge-smoke/workspace
```

`.env` 中保持同样结构：

```dotenv
MOSSBRIDGE_RUNTIME=codex
MOSSBRIDGE_STATE_DIR=/tmp/mossbridge-smoke/state
MOSSBRIDGE_DATA_ROOT=/tmp/mossbridge-smoke/data
MOSSBRIDGE_WORKSPACE_ROOT=/tmp/mossbridge-smoke/workspace
MOSSBRIDGE_ALLOWED_USER_IDS=
MOSSBRIDGE_ENABLE_CHECKIN=false
MOSSBRIDGE_ENABLE_DREAMING=false
```

Claude Code：

```dotenv
MOSSBRIDGE_RUNTIME=claudecode
MOSSBRIDGE_CLAUDE_MODEL=claude-opus-4-6
```

Codex 可选配置：

```dotenv
MOSSBRIDGE_CODEX_MODEL=
MOSSBRIDGE_CODEX_MODEL_PROVIDER=
MOSSBRIDGE_CODEX_NATIVE_IMAGE_INPUT=
MOSSBRIDGE_CODEX_COMMAND=
MOSSBRIDGE_CODEX_MODEL_CHOICES=cloud=gpt-5.4,local=gemma4:26b-32k@ollama
```

如果接 Ollama 等本地 provider，把 [templates/codex-local-provider.sh](./templates/codex-local-provider.sh) 复制到仓库外、设为可执行，再让 `MOSSBRIDGE_CODEX_COMMAND` 指向复制后的脚本。

## 访问控制

`MOSSBRIDGE_ALLOWED_USER_IDS` 保护正常微信入站链。

- 空 allowlist：只适合首次隔离登录/诊断，还不知道 sender id 时临时使用。
- 非空 allowlist：只有列出的 sender id 能进入。
- 未授权 sender 会在命令解析、绑定修改、附件下载、token 缓存和 runtime dispatch 前被拒绝。
- 日志只记录运行状态、id 和短预览，不输出 context token 或完整私聊正文。

QR 登录并确认 sender id 后，填写：

```dotenv
MOSSBRIDGE_ALLOWED_USER_IDS=the_sender_id_you_confirmed
```

然后重启 bridge。

## 默认被动

公开部署默认不主动发消息：

- `npm run shared:start` 启动 shared bridge，但不开 random check-in。
- `.env.example` 默认 `MOSSBRIDGE_ENABLE_CHECKIN=false`。
- `.env.example` 默认 `MOSSBRIDGE_ENABLE_DREAMING=false`。

只有前台 smoke 通过且用户明确要主动唤醒时再开启：

```bash
npm run shared:start:checkin
# 或
MOSSBRIDGE_ENABLE_CHECKIN=true npm run shared:start
```

Dreaming/metabolism 也需要显式开启：

```bash
MOSSBRIDGE_ENABLE_DREAMING=true npm run shared:start
```

## 验证

以下命令在隔离路径中运行，不需要 QR 登录：

```bash
npm run doctor
npm run smoke:memory-empty
npm run smoke:memory-chain
npm run verify
```

`npm run verify` 会跑语法检查和 Node 测试。它不等于真实微信首轮回复通过；真人仍需扫码并观察第一条回复。

## 只有用户明确要求时才启动

QR 登录、bridge start、service takeover 都不要由 AI 部署助手自动执行。用户明确要求本地 smoke 后再运行：

```bash
npm run login
npm run shared:start
```

然后在微信里发：

```text
/bind /tmp/mossbridge-smoke/workspace
/status
```

再发一条普通消息，确认收到自然回复。没有真人扫码和首轮回复观察，就不要写成 passed。

LaunchAgent/service 命令是 macOS-only：

```bash
npm run service:install:codex
npm run service:status:codex
npm run service:stop:codex
```

`service:takeover:*` 只在你明确要替换已有 Mossbridge LaunchAgent 时使用。

## 记忆与数据边界

空 `MOSSBRIDGE_DATA_ROOT` 是合法可用状态。没有 resident anchor、历史导入、网页抓取或 Notion sync，也应该能对话。

Resident warm anchor 只能作为可选步骤，在首次对话后由用户明确确认内容时写入。QR 登录前不要自动写人格/关系记忆；AI 部署助手不能按模板猜用户称呼、性别、关系、诊断、偏好或身份。

旧记忆迁移走 bundle：

```bash
npm run memory:export -- --source-data-root /path/to/source-data --out /tmp/mossbridge-memory-bundle --replace-output
npm run memory:import -- --bundle /tmp/mossbridge-memory-bundle
```

`memory:import` 默认 dry-run。真正 apply 只能落到隔离目标：

```bash
MOSSBRIDGE_STATE_DIR=/tmp/mossbridge-import/state \
MOSSBRIDGE_DATA_ROOT=/tmp/mossbridge-import/data \
npm run memory:import -- --bundle /tmp/mossbridge-memory-bundle --apply
```

不要让公开新部署直接指向 live shared data root。

## 常用命令

```bash
npm run doctor
npm run shared:status
npm run shared:open
npm run shared:model
npm run shared:refresh-session
```

微信命令包括：

- `/bind /absolute/path`
- `/status`
- `/model`
- `/model <id>`
- `/model --provider <id> <model>`
- `/model default`
- `/model refresh`
- `/reread`
- `/checkin <min>-<max>`
- `/chunk <number>`

更多见 [docs/commands.md](./docs/commands.md)。

## 已知限制

- 每个公开部署仍需真人做 clean-account QR login 和首轮微信回复验收。
- 记忆 mutation ledger 还没有完成 write-ahead/orphan mutation recovery。如果 store 写入成功但 ledger 落盘失败，仍是已知耐久性缺口。
- 自动网页对话抓取是后续扩展；当前 app daily capture 是手动验证/暂存/导入。
- Notion 同步是后续扩展，不属于第一轮部署。
- 记忆系统仍是本地文件 alpha，有测试和 smoke，但不宣称生产级数据耐久性。
- launchd service 脚本仅按 macOS 验证。其他平台可以手动跑 Node 进程，但 service 管理不宣称已验证。

## 文档

- [docs/ai-deployment.md](./docs/ai-deployment.md)
- [docs/quickstart.md](./docs/quickstart.md)
- [docs/release-status.md](./docs/release-status.md)
- [docs/architecture-for-humans.md](./docs/architecture-for-humans.md)
- [docs/brain-layer-boundary.md](./docs/brain-layer-boundary.md)
- [docs/memory-storage.md](./docs/memory-storage.md)
- [docs/memory-portability.md](./docs/memory-portability.md)
- [docs/app-daily-capture-json.md](./docs/app-daily-capture-json.md)
- [docs/safe-self-check.md](./docs/safe-self-check.md)

## License

Mossbridge 使用 `AGPL-3.0-only`。如果你修改它并通过网络向用户提供服务，需要遵守 AGPL 的源码提供要求。

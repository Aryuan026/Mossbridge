# Mossbridge Architecture For Humans

这份文档是给想先读懂项目的人看的，不是 API 手册。它适合发帖、转给朋友，或者给一个刚 clone 项目的 Codex 作为“先看这张地图”的入口。

一句话说，Mossbridge 是一个本地优先的 WeChat-to-agent bridge：微信负责日常入口，本地 runtime 负责思考和回复，Mossbridge 负责把账号、线程、记忆、文件、提醒、主动唤醒和故障提示这几件事接稳。

它来自 Cyberboss 的桥形态，但这个 fork 的重心不是“把模型接到微信”这么简单，而是让日常对话能沉淀出连续性：今天在微信里说过的事，下一次还能以合适的轻重被递给 Codex 或 Claude Code。第一版不是空桥外挂脑，而是让 Mossbridge 自己先带着一套可部署的本地 brain。

## The Shape

Mossbridge 可以想成五块。

第一层是嘴：WeChat channel。

它负责扫码登录、拉取消息、发送回复、处理图片和文件、维护 WeChat 的 context token。对应代码主要在 `src/adapters/channel/weixin/`。

第二块是发动机：runtime adapter。

现在支持 Codex 和 Claude Code。Mossbridge 不把自己写成 Claude Code-only，也不把 Codex 只当部署助手。两边都是一等 runtime。对应代码在：

- `src/adapters/runtime/codex/`
- `src/adapters/runtime/claudecode/`

第三块是手：tools 和非记忆 services。

它负责文件、提醒、贴纸、timeline、状态检查、bridge notice 这类“能做事的接口”。对应代码主要在 `src/tools/` 和 `src/services/`。

第四块是脑：Mossbridge 内置 brain。

它负责记忆布局、热上下文、温记忆、ongoing、小事记、事件簿、case、拓扑候选和上下文包。当前实现仍在历史目录 `src/asherie/`、`src/services/asherie-memory-service.js` 和 `src/asherie/storage-layout.js`，`src/brain/README.md` 是公开线的边界标记。

第五块是控制层：control plane。

它负责记录桥为什么行动：为什么心跳被跳过，为什么 runtime 进入冷却，为什么 memory packet 被缩短，为什么 dreaming 要重试。对应代码在 `src/control/`，账本写在 `MOSSBRIDGE_STATE_DIR/control-events.jsonl`。它不保存用户记忆，也不替主 AI 说话。

这五块中，嘴和手可以把材料递给脑，但不应该直接改脑的数据文件；runtime adapter 只负责发动机协议，不拥有记忆策略；control plane 只记因果和状态，不把运行噪音沉淀成用户记忆。

## The Three Roots

Mossbridge 特别在意把三类东西分开。

`MOSSBRIDGE_STATE_DIR` 是运行状态。

这里放账号、会话、队列、日志、冷却状态、control ledger、WeChat 配置。默认是 `~/.mossbridge`。它像桥的随身包，不应该提交到 git。

`MOSSBRIDGE_DATA_ROOT` 是记忆仓。

这里放 hot context、warm memory、notebook、ongoing tracks、conversation cache、observation journal、episode journal、case index、cold-version compatibility、mutation log。它像桥的长期笔记本和短期工作台。第一版公开部署先验证这套本地结构；网页 AI capture 可以手动导入到 cache/hot，但不接自动同步、不接 Notion、不接外源稳定记忆导入。

`MOSSBRIDGE_WORKSPACE_ROOT` 是工作区。

这里是 runtime 可以读写的文件范围，也是 `/bind` 绑定的地方。它不应该直接设成用户整个 Home 目录。

这三个根分开以后，别人 clone 代码时不会顺手带走你的账号、记忆、文件或测试痕迹。

## How One Message Moves

一条普通微信消息大概这样流动：

```text
WeChat
  -> channel adapter
  -> MossbridgeApp
  -> command / turn gate / attachment handling
  -> memory context packet
  -> Codex or Claude Code runtime adapter
  -> stream delivery back to WeChat
  -> turn writeback into conversation cache and memory stores
```

核心调度在 `src/core/app.js`。

它不是一个很薄的转发器。它会做这些判断：

- 当前 thread 是否已经有一轮在跑。
- 多条短消息或多张图片要不要合并成一轮。
- runtime 是否处在 quota/cooldown/first-event timeout。
- 回复应该直接发、分段发，还是延迟到下一条用户消息再补。
- 这一轮要带多少 memory prelude。
- 失败提示是否应该作为 `[Mossbridge]` 桥层通知，而不是伪装成主 bot 的自然回复。

现在这些判断会同步落一份轻量 control event，方便压测时回看“桥为什么这样做”。这份账本是运行因果，不是用户记忆。

## Memory Is Delivery, Not A Cage

Mossbridge 的记忆系统不是“人设锁”，也不是关键词控制器。它的目标是把该知道的上下文递给前台模型，让模型更连续、更少失忆。

主要几层是：

- `warm_memory`: 日常关系、偏好、象征物、稳定印象、常驻锚点。
- `cache/hot`: 刚发生的跨窗口上下文、合流缓冲、短投影和快照。
- `notebook`: 小事记、轻量日记、随手备注；它是人可读的原材料，不自动等于稳定事实。
- `ongoing_tracks`: 这段时间还没结束的事，例如项目、身体追踪、家庭动态、购买决策。
- `conversation_cache`: 最近对话尾巴，不是永久记忆，但能帮模型接住上下文。
- `observation_journal`: 可修正的观察，不把用户写死成标签。
- `episode_journal`: 有起止的事件盒子，例如旅行、照片分享、一个阶段性任务。
- `case_index`: “这个 agent 帮用户做过什么”的工作索引，适合项目、文件、调试、部署。
- `cold/version layer`: 兼容旧冷层或更深归档，第一版不要求依赖私人外部冷树。

记忆递送入口在 `src/services/asherie-memory-service.js`。底层 store 主要在 `src/asherie/`。

第一版公开目标是：空仓也能启动，能写温记忆，能维护 ongoing，能留下 notebook/case/episode 的落点，能把近期对话和相关记忆递进 runtime，并且能在安静窗口里跑最小可审计的 dreaming/metabolism。更复杂的多端同步、Notion、自动网页 AI capture 和高质量拓扑晋升策略仍然作为后续扩展。

## Runtime-Neutral By Design

Mossbridge 的共享能力应该放在 bridge core / brain service，而不是塞进某个 runtime adapter。

放在 core 的东西包括：

- WeChat 收发和命令路由
- state/data/workspace 目录布局
- 记忆上下文包
- reminders、check-ins、system turns
- runtime cooldown 和用户可见故障提示
- 附件、贴纸、文件、timeline 工作流
- safe self-check 和 launchd/shared-start

放在 runtime adapter 的东西只应该是协议差异：

- Codex 的 RPC、session、MCP config、model catalog
- Claude Code 的 process、session、approval、model 参数

这就是为什么 `/model`、`/status`、`/bind`、记忆工具和桥提示都应该尽量长在共享层。Codex 和 Claude Code 换的是发动机，不应该换整座桥。

## Tools Are The Hands

Runtime 能通过 MCP 工具做事。工具定义在 `src/tools/tool-host.js`，服务装配在 `src/tools/create-project-tooling.js` 和 `src/services/service-domains.js`。

当前工具面主要包括：

- 发文件、保存附件、处理贴纸
- 创建/查看/取消提醒
- 读写 warm memory
- 管理 ongoing tracks
- 写 observation / episode / solitude
- 记录 case index
- 读 cold memory compatibility
- timeline 读写和截图
- 读取 bridge status

公开版不提供私人外部 executor。也就是说，第三方账号、设备、权限管理这类能力不会以残留工具提示的方式混进 Mossbridge。

如果一个能力不能只靠 Mossbridge 自己的 public config、state root、data root 和 workspace root 工作，它就不该出现在第一版公开工具面里。

## Heartbeat Is Not A Greeting Timer

Mossbridge 的主动唤醒不是“隔一段时间发一句你好”。它更像桥在后台醒一下，先看看有没有 due reminder、recent context、ongoing、observation、cooldown、runtime pressure，再决定要不要说话。

相关代码包括：

- `src/app/system-checkin-poller.js`
- `src/core/system-message-dispatcher.js`
- `src/core/system-message-queue-store.js`
- `src/asherie/wakeup-store.js`

如果没有真实上下文价值，安静跳过或写后台记录比硬发一句更好。这个设计是为了让主动性像连续性，而不是像噪音。

## Failure Notices Belong To The Bridge

模型限额、runtime 掉线、发送失败、上下文过长，这些都不是主 bot 的人格内容。Mossbridge 会尽量把它们变成明确的桥层提示。

所以公开版的运行层通知会倾向于写成 `[Mossbridge] ...`，让用户知道这是系统状态，不是 assistant 在“演”一句安抚话。

这部分主要在：

- `src/core/runtime-notices.js`
- `src/core/stream-delivery.js`
- `src/core/runtime-cooldown-store.js`
- runtime adapters 的 failure event 映射

同一个原则也适用于记忆：失败提示、额度提示、维护碎碎念不应该写进用户记忆。

## Control Plane Keeps It From Becoming A Pile

Mossbridge 吸收的是控制论骨架，而不是把另一个框架塞进来。每个自动动作尽量走同一个图景：

```text
signal -> decision -> action -> feedback -> ledger
```

举几个例子：

- check-in：看到时间窗口和上下文压力，决定排队或跳过，然后记录原因。
- runtime：看到 quota/timeout/stall，决定冷却、提示、释放或重试，然后记录结果。
- memory：看到当前 turn 和 token 压力，决定递多少上下文，然后记录 delivery report。
- dreaming：看到 quiet window 和 source records，决定启动代谢，最后用 receipt 标记完成或重试。

这层的价值是把“自动性”变成可审计的工程行为。它不会去改 warm memory，不会替 Codex/Claude Code 决定协议，也不会把桥状态装成携带 soul 的主 AI 回复。

## What Is Deferred

第一版先保持 Mossbridge 本体完整，不急着把所有未来想象接上。

暂缓的线包括：

- 网页 AI capture 插件自动同步
- GPT / Rikkahub / Driftstone 外源记忆导入
- Notion stable memory 同步
- 更完整的 memory_tree topology provider
- dreaming 质量压测、跨端素材合流、自动拓扑晋升策略

这些都不是被否定，而是还没有到适合公开第一版承诺的成熟度。后续可以等私有压测线稳定，再按同一套 data root 和 runtime-neutral 原则迁回公开仓。

## How To Read The Code

如果你第一次打开 Mossbridge，可以按这个顺序读：

1. `README.md`
   先看它解决什么问题、怎么启动。

2. `AGENTS.md`
   给 Codex 或其他维护 agent 的边界说明，尤其是不要碰 live 服务、不要接私人数据仓。

3. `docs/quickstart.md`
   新 clone 的真实部署路径。

4. `docs/codex-memory-setup.md`
   给 Codex 的施工说明，解释为什么要分 state/data/workspace，为什么记忆递送参数要克制。

5. `src/index.js`
   CLI 入口和命令分发。

6. `src/core/app.js`
   整座桥的主循环。

7. `src/adapters/channel/weixin/`
   微信这一侧怎么进出。

8. `src/adapters/runtime/codex/` 和 `src/adapters/runtime/claudecode/`
   两个 runtime 怎么接入。

9. `src/services/asherie-memory-service.js` 和 `src/asherie/`
   记忆仓、召回、上下文包怎么工作。

10. `src/control/` 和 `docs/control-plane.md`
    心跳、runtime、记忆递送、dreaming 的因果账本怎么工作。

11. `docs/brain-layer-boundary.md` 和 `src/brain/README.md`
    嘴、手、runtime engine、brain 的边界怎么划。

12. `src/tools/tool-host.js`
    runtime 能调用哪些手。

## The Small Philosophy

Mossbridge 不是云端人格平台，也不是把所有生活工具都接进模型的万能遥控器。它更像一座本地小桥：一边是你已经在用的微信，一边是本地运行的 Codex 或 Claude Code，中间放一个能记得、能递上下文、能保持边界的桥身。

这座桥的第一版目标很朴素：

- clone 后能装。
- 空仓也能跑。
- Codex 和 Claude Code 都能当 runtime。
- 微信能自然对话。
- 记忆递送能工作。
- 私人账号、私人记忆、私人外部系统能力不混进公开仓。

后面再长出多端同步、浏览器 capture、Notion、dreaming，都应该长在这个边界清楚的身体上：先进入 hot/cache/notebook，再由本地 brain 整理成 warm、ongoing、episode、case 或 topology，而不是把第一版变成一团看不清来源的自动化魔法。

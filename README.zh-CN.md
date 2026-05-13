致谢：Mossbridge / 苔藓小桥由 [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss) 分叉而来；微信桥、runtime 外壳与 AGPL 授权脉络来自该项目。

# Mossbridge / 苔藓小桥

Mossbridge 是一个本地优先的 WeChat bridge，用来把 Codex 或 Claude Code 接入微信。

它保留了 Cyberboss 最有价值的“嘴”：一个微信账号、一个本地 runtime、一套收消息/发消息/传文件/自唤醒/共享线程的链路。在这层外壳之上，苔藓小桥正在长成更偏记忆与陪伴的系统：热上下文、温记忆、小事记/笔记本、近中期追踪、case memory、可选冷树兼容、携带记忆的主动唤醒，以及代码本体、私人数据、测试数据的分离。

本仓库不是上游 Cyberboss，也不是 Cyberboss 官方版本。

## 和 Cyberboss 的主要差异

- **记忆优先**
  Mossbridge 增加了自己的内置 brain，包括热上下文、温卡、小事记/笔记本、ongoing tracks、context packet、case index、冷记忆版本兼容和近期对话缓存。前台模型可以通过工具读取、写入、修改和删除记忆，而不是只依赖当前窗口上文。

- **陪伴连续性，而不是固定人设控制**
  记忆管理层不应该用关键词式规则限制模型必须怎么说话。提示词的目标是帮助模型理解上下文、保持关系连续，而不是把它锁死成某种固定口吻。

- **主动唤醒携带上下文**
  随机 check-in 和定时 reminder 都被当作“模型醒来后的系统轮次”，而不是普通闹钟。唤醒时可以携带近期上下文、温记忆和 ongoing 信息，避免主动消息像固定日历一样干瘪。

- **本地记忆仓姿态**
  第一版先保持 Mossbridge 本体完整：WeChat、选定 runtime 和 Mossbridge 自己的数据根。ChatGPT 网页/app 抓取或第三方 chatbox 未来可以作为数据入口接进来，但 raw capture 应先进入 hot/cache，再由本地 brain 整理，不直接变成稳定记忆。

- **近中期追踪层**
  减重、写稿、家族八卦、购买决策、系统 bug、咨询进展这类“这阵子还活着的事”，可以挂在 ongoing tracks，而不是太早冻结成永久冷记忆。

- **可选冷树兼容**
  Mossbridge 可以通过配置读取或修补冷层结构，但目前不建议让 WeChat 端日常陪伴强依赖私人外部冷树。温层负责日常连续性，冷层更适合做深层归档、关系拓扑和时间拓扑。

- **表情包与附件工作流**
  微信图片和文件可以落入 inbox，被总结进上下文；适合作为表情包的图片可以登记到本地 sticker catalog，让模型用工具发真实表情包，而不是输出 `[微笑]` 这种文字替代。

- **微信回复处理**
  当前加入了回复分段、短句合并、段落呼吸和微信 emoji shortcode 归一化，减少“同一个模型在微信端变短变硬”的传输层影响。

- **Codex / Claude Code 双 runtime**
  支持 Codex 和 Claude Code。日常推荐 shared mode，让微信端和终端端挂在同一条线程上；`/model` 是共享命令，Codex 有目录时用目录校验，Claude Code 没有稳定目录时接受原始 model id。

## 为什么会多这些参数

Mossbridge 的配置比原始 bridge 多，是因为它要把三件事分清楚：微信账号运行态、助手自己的记忆仓、用户给 runtime 读写的工作区。

- `MOSSBRIDGE_STATE_DIR` 是运行态：二维码登录、账号文件、session、日志、队列、cooldown、生成的微信提示文件。默认是 `${HOME}/.mossbridge`。
- `MOSSBRIDGE_DATA_ROOT` 是记忆数据：hot context、温卡、小事记、ongoing、observation / episode journal、conversation cache、case index、app capture 和 mutation log。新部署先只接一个干净 data root，再考虑导入旧仓。
- `MOSSBRIDGE_WORKSPACE_ROOT` 是 runtime 可读写的办公区，用来收附件、写文件、做项目协作，不应该直接暴露整个 Home。
- `MOSSBRIDGE_CHECKIN_*` 控制心跳机会，不只是闹钟频率。hot window 和 token backoff 是为了避免主动唤醒打断正在聊天的用户，或把已经很重的 runtime 上下文继续压满。
- `MOSSBRIDGE_ASHERIE_PRELUDE_*` 是历史记忆层命名，控制一轮里递送多少记忆。限制保持小，是为了让记忆帮助当前回复落地，而不是把整仓流水灌进窗口。
- `MOSSBRIDGE_MAINTENANCE_*` 让公开版心跳默认只读自检。私有部署可以显式打开修复，但公开 clone 验收应该先只检查和报告。

## 公开命名与 runtime 姿态

公开入口已经统一到 Mossbridge：

- package / CLI：`mossbridge`
- 环境变量前缀：`MOSSBRIDGE_*`
- 默认状态目录：`${HOME}/.mossbridge`
- launchd label：`com.mossbridge.bridge`
- MCP 命名空间：`mossbridge_tools` / `mossbridge_*`

Codex 和 Claude Code 都是一等 runtime。微信收发、记忆仓、wakeups、附件、故障提示这些共享能力优先放在 bridge core；只有 Codex RPC/session、Claude Code process/session/model 这类协议差异才放进各自 adapter。

代码里仍有少量历史的 Asherie 记忆域命名，除致谢、来源说明、迁移说明或记忆域词汇外，都应该视为公开前清理债。

## 安装

```bash
git clone https://github.com/Aryuan026/Mossbridge.git
cd Mossbridge
npm install
```

第一次扫码登录、`/bind` 和空仓首轮回复的完整路径见 [docs/quickstart.md](./docs/quickstart.md)。

## 最小配置

在项目目录创建本地 `.env`。`.env`、账号状态和私人记忆数据不应该进入 git。

```dotenv
MOSSBRIDGE_RUNTIME=codex
MOSSBRIDGE_WORKSPACE_ROOT=/absolute/path/to/your/workspace
MOSSBRIDGE_STATE_DIR=/absolute/path/to/mossbridge-state
MOSSBRIDGE_DATA_ROOT=/absolute/path/to/mossbridge-data
MOSSBRIDGE_ALLOWED_USER_IDS=
```

如果使用 Claude Code，只额外改：

```dotenv
MOSSBRIDGE_RUNTIME=claudecode
MOSSBRIDGE_CLAUDE_MODEL=claude-opus-4-6
```

可选的旧记忆仓迁移配置：

```dotenv
MOSSBRIDGE_ASHERIE_WARM_MEMORY_DIR=/absolute/path/to/warm_memory
MOSSBRIDGE_ASHERIE_TRUTH_LAYER_DIR=/absolute/path/to/truth_layer
MOSSBRIDGE_ASHERIE_MEMORY_VERSION_BANK_DIR=/absolute/path/to/memory_versions
```

新部署优先只设置 `MOSSBRIDGE_DATA_ROOT`。更细的路径只用于有意识地迁移或共享既有记忆仓。

## 常用命令

```bash
npm run login
npm run shared:start
npm run shared:open
npm run shared:status
```

Claude Code 对应命令：

```bash
npm run shared:start:claudecode
npm run shared:open:claudecode
npm run shared:status:claudecode
```

常用微信命令：

- `/bind /absolute/path`
  绑定当前聊天到一个工作目录。
- `/status`
  查看 workspace、thread、model 和上下文状态。
- `/model`
  查看当前 runtime 的 selected / default / effective model 和模型目录状态。
- `/model <id>`
  为下一轮选择模型。Codex 会优先使用模型目录校验；Claude Code 没有稳定目录时接受原始 model id。
- `/model default`
  清除当前 workspace 的模型覆盖，下一轮回到 runtime 默认模型。
- `/model refresh`
  让 runtime adapter 刷新模型目录。
- `/reread`
  重新注入本地指令和操作模板。
- `/checkin <min>-<max>`
  调整随机主动唤醒频率。
- `/chunk <number>`
  调整微信短回复合并阈值。

## 数据边界

Mossbridge 的目标是让代码和私人数据可分割。

- git 里只放源码、模板、测试和文档。
- 微信账号状态留在 `${HOME}/.mossbridge` 或其他被忽略的状态目录。
- 私人记忆留在 `MOSSBRIDGE_DATA_ROOT` 或显式配置的记忆仓。
- 测试数据应该可以删除，而不影响稳定记忆。
- 公开发布前不能包含私人记忆卡、账号 token、本地日志、二维码数据或个人 workspace 绑定。
- 嘴、手和 runtime adapter 不直接写 brain 文件；记忆写入应走 memory service 边界。

## 记忆层

当前记忆地图：

- **温记忆**
  日常关系连续性、偏好、象征物、固定印象和可复用上下文卡。
- **热记忆**
  刚发生的跨窗口上下文、合流缓冲、短投影和快照。
- **小事记 / notebook**
  人能读的轻量笔记和日记原材料，不自动等于稳定事实。
- **ongoing tracks**
  近中期活跃事件，不一定是永久事实，但需要持续挂在前台附近。
- **conversation cache**
  多窗口近期尾巴和上文切片，可供 dreaming 或 context packet 使用。
- **cold/version layer**
  深层归档、旧记忆包兼容、未来关系/时间拓扑。
- **case index**
  记录“我帮你做过什么事”的工作索引层，尤其适合文件工作和项目协作。

更多见 [docs/memory-storage.md](./docs/memory-storage.md)。

## 公开前清洗清单

- 确保历史 `ASHERIEBRIDGE_*` 和 Cyberboss 名称不再作为运行入口，只在迁移说明或上游来源说明里出现
- 决定旧 state dir 别名是支持迁移还是明确不支持
- 全仓扫描私人路径、私人名字、测试账号、截图和记忆样例
- 确认空记忆仓也能跑起来
- 写清楚哪些功能内置，哪些需要用户自己的记忆仓提供

## 文档

- [docs/commands.md](./docs/commands.md)
- [docs/quickstart.md](./docs/quickstart.md)
- [docs/architecture-for-humans.md](./docs/architecture-for-humans.md)
- [docs/brain-layer-boundary.md](./docs/brain-layer-boundary.md)
- [docs/memory-storage.md](./docs/memory-storage.md)
- [docs/codex-memory-setup.md](./docs/codex-memory-setup.md)
- [docs/app-daily-capture-json.md](./docs/app-daily-capture-json.md)
- [docs/notion-memory-interop.md](./docs/notion-memory-interop.md)
- [docs/gateway-shaped-architecture.md](./docs/gateway-shaped-architecture.md)
- [docs/public-release-readiness.md](./docs/public-release-readiness.md)

## License

本项目保留上游 AGPL 授权脉络，使用 `AGPL-3.0-only`。

如果你修改、扩展，并通过网络向用户提供服务，需要按 AGPL 要求提供对应源代码。

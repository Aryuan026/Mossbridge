致谢：Mossbridge / 苔藓小桥由 [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss) 分叉而来；微信桥、runtime 外壳与 AGPL 授权脉络来自该项目。

# Mossbridge / 苔藓小桥

Mossbridge 是一个本地优先的 WeChat bridge，用来把 Codex 或 Claude Code 接入微信。

它保留了 Cyberboss 最有价值的“嘴”：一个微信账号、一个本地 runtime、一套收消息/发消息/传文件/自唤醒/共享线程的链路。在这层外壳之上，苔藓小桥正在长成更偏记忆与陪伴的系统：温记忆、近中期追踪、近期上下文缓存、可选冷树兼容、携带记忆的主动唤醒，以及代码本体、私人数据、测试数据的分离。

本仓库不是上游 Cyberboss，也不是 Cyberboss 官方版本。

## 和 Cyberboss 的主要差异

- **记忆优先**
  Mossbridge 增加了 Asherie 风格的记忆层，包括温卡、ongoing tracks、context packet、冷记忆版本兼容和近期对话缓存。前台模型可以通过工具读取、写入、修改和删除记忆，而不是只依赖当前窗口上文。

- **陪伴连续性，而不是固定人设控制**
  记忆管理层不应该用关键词式规则限制模型必须怎么说话。提示词的目标是帮助模型理解上下文、保持关系连续，而不是把它锁死成某种固定口吻。

- **主动唤醒携带上下文**
  随机 check-in 和定时 reminder 都被当作“模型醒来后的系统轮次”，而不是普通闹钟。唤醒时可以携带近期上下文、温记忆和 ongoing 信息，避免主动消息像固定日历一样干瘪。

- **多窗口记忆姿态**
  WeChat、终端、Home 前端或第三方 chatbox 可以被视为不同窗口。它们未来可以写入同一个记忆沉淀区，同时仍然保持各自的通道身份。

- **近中期追踪层**
  减重、写稿、家族八卦、购买决策、系统 bug、咨询进展这类“这阵子还活着的事”，可以挂在 ongoing tracks，而不是太早冻结成永久冷记忆。

- **可选冷树兼容**
  Mossbridge 可以通过配置读取或修补冷层结构，但目前不建议让 WeChat 端日常陪伴强依赖私人 Home 冷树。温层负责日常连续性，冷层更适合做深层归档、关系拓扑和时间拓扑。

- **表情包与附件工作流**
  微信图片和文件可以落入 inbox，被总结进上下文；适合作为表情包的图片可以登记到本地 sticker catalog，让模型用工具发真实表情包，而不是输出 `[微笑]` 这种文字替代。

- **微信回复处理**
  当前加入了回复分段、短句合并、段落呼吸和微信 emoji shortcode 归一化，减少“同一个模型在微信端变短变硬”的传输层影响。

- **Codex / Claude Code 双 runtime**
  支持 Codex 和 Claude Code。日常推荐 shared mode，让微信端和终端端挂在同一条线程上，也支持在 Claude Code runtime 下查看和切换模型。

## 当前命名状态

仓库名已经是 `Mossbridge`，但内部入口仍然保留工作名 `asheriebridge`。

这是有意保留的稳定状态。命令名、MCP 工具名、环境变量、测试夹具、本地状态目录彼此相连，应该在公开发布前做一次统一清洗，而不是在真机测试过程中硬改。

目前仍会看到：

- 命令：`asheriebridge`
- 环境变量前缀：`ASHERIEBRIDGE_*`
- 默认状态目录：`${HOME}/.asheriebridge`
- MCP 命名空间：`asheriebridge_tools` / `asheriebridge_*`

公开前需要把 CLI、package、MCP、文档和本地状态目录统一改成 `mossbridge` 或提供兼容别名。

## 安装

```bash
git clone https://github.com/Aryuan026/Mossbridge.git
cd Mossbridge
npm install
```

## 最小配置

在项目目录创建本地 `.env`。`.env`、账号状态和私人记忆数据不应该进入 git。

```dotenv
ASHERIEBRIDGE_USER_NAME=YourName
ASHERIEBRIDGE_ALLOWED_USER_IDS=your_wechat_user_id
ASHERIEBRIDGE_WORKSPACE_ROOT=/absolute/path/to/your/workspace
ASHERIEBRIDGE_RUNTIME=claudecode
ASHERIEBRIDGE_CLAUDE_MODEL=claude-opus-4-6
```

可选记忆仓配置：

```dotenv
ASHERIEBRIDGE_DATA_ROOT=/absolute/path/to/bridge-data
ASHERIEBRIDGE_ASHERIE_WARM_MEMORY_DIR=/absolute/path/to/warm_memory
ASHERIEBRIDGE_ASHERIE_TRUTH_LAYER_DIR=/absolute/path/to/truth_layer
ASHERIEBRIDGE_ASHERIE_MEMORY_VERSION_BANK_DIR=/absolute/path/to/memory_versions
```

新部署优先只设置 `ASHERIEBRIDGE_DATA_ROOT`。更细的路径主要用于兼容旧数据仓或接入 AsherieHome。

## 常用命令

```bash
npm run login
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
  查看当前 Claude Code 模型。
- `/model <id>`
  在 runtime 支持时切换模型。
- `/reread`
  重新注入本地指令和操作模板。
- `/checkin <min>-<max>`
  调整随机主动唤醒频率。
- `/chunk <number>`
  调整微信短回复合并阈值。

## 数据边界

Mossbridge 的目标是让代码和私人数据可分割。

- git 里只放源码、模板、测试和文档。
- 微信账号状态留在 `${HOME}/.asheriebridge` 或其他被忽略的状态目录。
- 私人记忆留在 `ASHERIEBRIDGE_DATA_ROOT` 或显式配置的记忆仓。
- 测试数据应该可以删除，而不影响稳定记忆。
- 公开发布前不能包含私人记忆卡、账号 token、本地日志、二维码数据或个人 workspace 绑定。

## 记忆层

当前记忆地图：

- **温记忆**
  日常关系连续性、偏好、象征物、固定印象和可复用上下文卡。
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

- 把 CLI/package/MCP 命名空间从 `asheriebridge` 改成 `mossbridge`
- 处理 `ASHERIEBRIDGE_*` 环境变量，是改名还是保留兼容别名
- 决定 `${HOME}/.asheriebridge` 是否作为旧数据迁移别名保留
- 全仓扫描私人路径、私人名字、测试账号、截图和记忆样例
- 确认空记忆仓也能跑起来
- 写清楚哪些功能内置，哪些需要用户自己的记忆仓提供

## 文档

- [docs/memory-storage.md](./docs/memory-storage.md)
- [docs/codex-memory-setup.md](./docs/codex-memory-setup.md)
- [docs/gateway-shaped-architecture.md](./docs/gateway-shaped-architecture.md)
- [docs/public-release-readiness.md](./docs/public-release-readiness.md)

## License

本项目保留上游 AGPL 授权脉络，使用 `AGPL-3.0-only`。

如果你修改、扩展，并通过网络向用户提供服务，需要按 AGPL 要求提供对应源代码。

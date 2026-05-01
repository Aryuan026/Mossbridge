# Mossbridge Public Release Readiness

这份文档是 Mossbridge / 苔藓小桥的本地进度备份。

它记录当前私有备份已经完成到哪里、为什么现在还不适合直接公开分享、以及未来要把它交给朋友使用前必须补齐哪些东西。这里不记录私人记忆内容、账号 token、测试聊天原文或本地二维码数据。

Last updated: 2026-05-01

## 当前结论

Mossbridge 当前处在“可继续私有优化、可备份、不可直接公开分发”的阶段。

它已经不是原始 Cyberboss 的简单改名版，而是一个以 WeChat bridge 为外壳、往记忆连续性和本地陪伴系统方向生长的分支。但代码内部仍有不少历史命名和私人部署假设，公开前必须清理。

一句话：

```text
现在可以当作私人桥继续养。
还不能当作朋友拿来就能跑的公开产品。
```

## 已完成的私有备份状态

- GitHub 私有仓库已建立为 `Aryuan026/Mossbridge`。
- 本地 `origin` 指向 Mossbridge 私有仓库。
- 原 Cyberboss 仓库保留为 `upstream`，用于之后继续对比上游更新。
- README 和中文 README 已改为 Mossbridge 门面，并在第一行致谢 Cyberboss。
- 现有代码、模板、测试和文档已经完成一次私有封仓提交。
- 运行态数据、账号信息、日志、inbox、stickers 自定义仓位、记忆仓等已通过 `.gitignore` 与代码仓分离。

## 当前已经具备的能力

### WeChat 与 runtime 桥

- 支持 WeChat QR 登录与本地账号保存。
- 支持 Codex 和 Claude Code runtime。
- 支持 shared mode，让微信与终端观察同一条共享线程。
- 支持 `/bind`、`/status`、`/reread`、`/checkin`、`/model`、`/chunk` 等日常命令。
- 支持主动系统轮次、定时 reminder、随机 check-in、文件发送和基础诊断。

### 记忆与上下文

- 已有 warm memory、ongoing tracks、conversation cache、memory version bank、cold root provider 的代码入口。
- 前台模型可以通过工具读写温记忆、修改记忆、读取 context packet、处理 ongoing 追踪。
- 主动唤醒已经接入记忆上下文，不再只是裸 reminder。
- 记忆仓可配置到独立 data root，也可兼容 AsherieHome 的现有数据路径。
- 代码层面已经强调数据本体、测试数据、稳定记忆和本地账号状态分离。

### 表情包与附件

- 已有本地 sticker catalog。
- 支持列出、选择、发送、保存、更新、删除表情包。
- WeChat 图片和附件可进入 inbox，并生成面向上下文的文字说明。
- 回复分段、短句合并、段落呼吸和 emoji shortcode 处理已经做过一轮优化。

### 文档与架构说明

- `README.md` / `README.zh-CN.md` 已解释 Mossbridge 与 Cyberboss 的关系。
- `docs/memory-storage.md` 已记录记忆仓设计、温层/ongoing/冷层/case index 的边界。
- `docs/gateway-shaped-architecture.md` 已记录“换内部实现，不拆微信嘴”的迁移原则。
- `docs/commands.md` 已记录当前命令分层。

## 目前不适合公开分享的原因

### 1. 内部命名仍未统一

公开仓名叫 Mossbridge，但内部仍有大量工作名：

- `asheriebridge`
- `AsherieBridge`
- `ASHERIEBRIDGE_*`
- `${HOME}/.asheriebridge`
- `asheriebridge_tools`
- 部分旧文档里的 `cyberboss`

这些现在不影响私人运行，但会让朋友部署时困惑。公开前需要统一改名或提供清晰兼容别名。

### 2. 仍然带有私人部署假设

当前私用环境中，bridge 可以接入 AsherieHome 的数据根、warm memory、truth layer 或其他本地仓位。朋友部署时不应该默认需要这些私人路径。

公开前必须验证：

- 空数据仓能启动。
- 没有 AsherieHome 也能完成日常对话。
- 没有私人温卡、冷树、case index 时，系统不会报错。
- 文档明确哪些是内置能力，哪些是用户自己的外接记忆仓。

### 3. 冷层与 dreaming 仍在演进

当前判断是：WeChat 日常陪伴不应强依赖 Home 冷树。温记忆和 ongoing tracks 应该先保证日常连续性，冷层更适合做关系拓扑、时间拓扑和深层归档。

公开前还需要继续验证：

- dreaming 在用户静默后能稳定触发。
- WeChat 与其他窗口写入的 conversation cache 都能进入整理素材。
- ongoing tracks 能被整理进温层，而不是过早冻结到冷层。
- 冷层拓扑不是另一套文本检索仓，而是真的能表达关系网络。
- 记忆错误时，模型能找到正确卡片并修改，而不是新增重复卡。

### 4. 新用户安装链路还没做完整验收

目前验证主要发生在私人机器、私人 WeChat 账号、私人记忆仓和当前 workspace 下。

公开前需要做一次新用户路径验收：

- 新 clone。
- 新 `.env`。
- 新 WeChat 登录。
- 新 workspace bind。
- 空 memory data root。
- Claude Code 和 Codex 各跑一次最小链路。
- 主动 wakeup、reminder、sticker、附件 inbox、memory tool 都跑一轮。

### 5. 隐私清洗还没做终检

公开前必须全仓检查：

- 私人绝对路径。
- 微信账号、user id、account id、thread id。
- 私人截图。
- 私人聊天样例。
- 私人记忆卡、温卡、冷树、case 记录。
- 测试中硬编码的私人目录。
- README 或 docs 中可能暴露个人使用痕迹的描述。

## 公开前必须做的工程清单

### 命名清洗

- 将 package name 改为 `mossbridge`。
- 增加或替换 CLI 命令为 `mossbridge`。
- 决定是否保留 `asheriebridge` 作为兼容别名。
- 将 MCP server namespace 改为 `mossbridge_tools`，或提供过渡期双命名。
- 将工具名从 `asheriebridge_*` 迁移到 `mossbridge_*`。
- 将默认状态目录迁移到 `${HOME}/.mossbridge`。
- 处理 `ASHERIEBRIDGE_*` 环境变量：直接改名，或兼容 `MOSSBRIDGE_*` + 旧名 fallback。

### 数据仓独立化

- 新建默认数据仓模板。
- 写清楚 data root 目录结构。
- 确认测试数据与稳定记忆分离。
- 确认自定义 stickers、inbox、logs、accounts 永远不会进入 git。
- 提供空仓启动 smoke test。
- 提供迁移旧数据的说明，但不把私人 AsherieHome 作为默认依赖。

### 记忆系统补强

- 完成 ongoing tracks 到 warm memory 的整理链路。
- 完成跨窗口 conversation cache 到 dreaming 的整理链路。
- 给冷层拓扑定义更稳定的 provider 接口。
- 明确 case index 的落盘结构和召回入口。
- 明确 Notion stable memory 与本地 warm/tree/case 的导入导出契约。
- 为 Driftstone/Notion staging 增加归一化层，避免第一轮导出格式直接写进 memory tree。
- 明确官方 app / ChatGPT web daily capture 如何进入 conversation cache。
- 验证主动 wakeup 的 context packet 足够支撑自然对话。
- 避免通过关键词作弊提高个别记忆召回。

### 运行稳定性

- 检查 Claude Code session timeout、runtime exited、first event timeout 等错误处理。
- 明确模型选择、模型显示和默认模型配置。
- 确认 thinking 模式不会把思维链作为回复正文发到微信。
- 确认额度提示、限额错误和 runtime 掉线提示不会污染对话体验。
- 确认 check-in 频率、drop 逻辑和“可以打扰用户”的提示边界。

### WeChat 体验

- 继续测试长回复分段是否自然。
- 继续测试微信 emoji shortcode 不再泄漏成 `[微笑]`、`[右哼哼]` 这类文本。
- 完成表情包后台录入和真实发送测试。
- 完成图片说明进入上下文的验证。
- 增加前台单条删除、重新发送或打断后的重试体验。

### 文档与朋友部署

- 写 `docs/quickstart.md`。
- 完善 `.env.example`，并在新机器上验证。
- 写 “第一次扫码登录” 指南。
- 写 “如何绑定 workspace” 指南。
- 写 “如何切换 Claude 模型” 指南。
- 写 “记忆仓可以不用 / 可以外接 / 可以共享”的说明。
- 写 “Notion 固有记忆同步 / 官方 app 每日抓取”说明。
- 写 “从 Cyberboss 分叉而来，差异在哪里”的公开说明。

## 分享给朋友前的验收标准

可以公开或发给朋友前，至少要满足：

- 在一台没有私人数据的新环境里可以安装启动。
- 不接 AsherieHome 也可以聊天、提醒、主动唤醒、收发文件。
- 空记忆仓不会报错。
- 新用户可以看 README 跑完登录、绑定、启动。
- 朋友不需要理解你的私人记忆结构也能使用基础 bridge。
- 所有私人路径、截图、账号、日志和记忆都已经清除。
- 公开仓里的名字统一为 Mossbridge，或文档清楚解释历史兼容名。

## 现在的维护策略

当前阶段仍以私有优化为主：

- 继续在现有本地仓位上实测 WeChat 日常对话。
- 继续把真实发现的问题写入代码和文档。
- 不急着把内部命名全改掉，避免打断当前可运行链路。
- 每完成一轮稳定优化，就提交到私有 GitHub 仓库备份。
- 等冷层、dreaming、memory provider 和新用户安装链路稳定后，再做公开前清洗。

Mossbridge 现在像一座已经能走的小桥，但桥边还有脚手架。私有备份保存的是“它已经长出来了”，公开发布要等的是“别人踩上去也不会被脚手架绊倒”。

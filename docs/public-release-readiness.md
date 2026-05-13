# Mossbridge Public Release Readiness

这份文档是 Mossbridge / 苔藓小桥的本地进度备份。

它记录当前私有备份已经完成到哪里、为什么现在还不适合直接公开分享、以及未来要把它交给朋友使用前必须补齐哪些东西。这里不记录私人记忆内容、账号 token、测试聊天原文或本地二维码数据。

Last updated: 2026-05-13

## 当前结论

Mossbridge 当前处在“可继续私有优化、可备份、不可直接公开分发”的阶段。

它已经不是原始 Cyberboss 的简单改名版，而是一个以 WeChat bridge 为外壳、往记忆连续性和本地陪伴系统方向生长的分支。但代码内部仍有不少历史命名和私人部署假设，公开前必须清理。

2026-05-05 之后，公开前评估口径改成 **runtime-neutral public readiness**：当前私测常用 Claude Code，但 Codex 也是一等 runtime。启动守护、记忆仓、附件、wakeups、故障提示和公开部署文档都应优先落在共享 bridge 层；只有 runtime 协议不同的地方才进入 `codex` 或 `claudecode` adapter。

同日新增一个隔离孵化仓：`0-github/Mossbridge`。这个副本用于公开版重命名、空仓验证和新微信绑定测试；它不复用当前正在测试的 Claude Code 前台 service、状态目录或记忆仓。

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
- 新增 runtime-neutral 公开前验收文档：`docs/runtime-neutral-readiness.md`。
- 本地 launchd service 脚本已补出 Codex 和 Claude Code 两组 npm 命令。
- 隔离副本已完成第一轮公开命名清洗：package/CLI/env prefix/default state dir/MCP namespace/launchd label 均改为 Mossbridge 系列。
- 隔离副本默认 state dir 为 `${HOME}/.mossbridge`，默认 launchd label 为 `com.mossbridge.bridge`，不会覆盖私人 live 测试线使用的旧 service label。
- `service:status:*` 已改到无依赖状态查询路径：即使尚未 `npm install`，也能显示 service 是否安装，而不是因为工具依赖缺失直接崩掉。
- 2026-05-06：新增 `docs/quickstart.md`，把 clean clone、独立 state/data/workspace、QR 登录、`/bind`、首轮回复和 Codex/Claude Code 双 runtime smoke 串成一条路径。
- 2026-05-06：清理 `README.en.md` 的旧 Cyberboss 安装面，公开 README 现在默认 Codex，同时给出 Claude Code 对等命令。
- 2026-05-06：`src/core/app.js` 新增 `MossbridgeApp` 导出；2026-05-10 移除旧测试/旧调用 app 别名，公开仓代码入口不再保留旧 app 名。
- 2026-05-10：从 live 压测仓只读同步四个共享层修复到公开仓：WeChat CDN 上传限时重试、过期 check-in opportunity 清理、cold root 搜索阈值、tooling services 注入 config；同时补入 tool 描述的前台语气边界，避免工具说明污染回复风格。
- 2026-05-10：明确 Mossbridge 公开线不提供私人外部执行器接口。未来重点是 OpenAI user 的 `ChatGPT 日常对话 / 网页抓取 -> Mossbridge 沉淀仓 -> Codex/Claude Code runtime -> WeChat 延续`，不可公开的外部执行器不进入公开工具面。
- 2026-05-07：对齐 dreaming 发布风险：私测可以借外部 scheduler，但公开版必须由 Bridge 自己拥有静默窗口触发、整理日志、写入回执和 runtime 故障提示。
- 2026-05-08：补入 dreaming completion-gate 提醒：公开版实现 Bridge-owned dreaming 时，不能把“触发过”当成“整理成功”。必须以 mutation/writeback 成功为完成条件；前台活跃、runtime 错误、解析错误或写入失败都要延迟重试同一任务，并留下 retry 回执。
- 2026-05-13：同步公开版交付说明：README / AGENTS / quickstart / Codex memory setup 解释心跳系统、记忆递送、状态/数据/workspace 隔离和主要参数原因；公开示例 `agent_id` 改为 `moss`，默认未配置 data root 时落到 `mossbridge_data/`；桥提示改成明确 `[Mossbridge]` 运行层通知，避免和主 bot 口吻混淆；`/model` 扩展为 Codex / Claude Code 通用的下一轮模型覆盖命令。

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
- 记忆仓可配置到独立 data root，也可在明确迁移时兼容既有本地记忆仓路径。
- 代码层面已经强调数据本体、测试数据、稳定记忆和本地账号状态分离。

### 表情包与附件

- 已有本地 sticker catalog。
- 支持列出、选择、发送、保存、更新、删除表情包。
- WeChat 图片和附件可进入 inbox，并生成面向上下文的文字说明。
- 回复分段、短句合并、段落呼吸和 emoji shortcode 处理已经做过一轮优化。

### 文档与架构说明

- `README.md` / `README.zh-CN.md` / `README.en.md` 已解释 Mossbridge 与 Cyberboss 的关系，并将公开安装入口指向 Mossbridge。
- `docs/memory-storage.md` 已记录记忆仓设计、温层/ongoing/冷层/case index 的边界。
- `docs/release-alignment-checklist.md` 已记录私测发现的问题如何同步到公开版验收口径。
- `docs/gateway-shaped-architecture.md` 已记录“换内部实现，不拆微信嘴”的迁移原则。
- `docs/commands.md` 已记录当前命令分层。

## 目前不适合公开分享的原因

### 1. 命名清洗仍需终检

隔离副本已完成第一轮代码级重命名：

- `mossbridge`
- `Mossbridge`
- `MOSSBRIDGE_*`
- `${HOME}/.mossbridge`
- `mossbridge_tools`

公开前仍需做最终语义审计：哪些 `Asherie` 是私人系统名，哪些只是记忆模块历史术语；哪些 `Cyberboss` 是致谢和来源说明，哪些是不该留在公共文档里的旧称。

### 2. 仍然带有私人部署假设

当前私用环境中，bridge 可以接入私人数据根、warm memory、truth layer 或其他本地仓位。朋友部署时不应该默认需要这些私人路径。

公开前必须验证：

- 空数据仓能启动。
- 没有私人外部记忆仓也能完成日常对话。
- 没有私人温卡、冷树、case index 时，系统不会报错。
- 文档明确哪些是内置能力，哪些是用户自己的外接记忆仓。

### 3. 冷层与 dreaming 仍在演进

当前判断是：WeChat 日常陪伴不应强依赖私人外部冷树。温记忆和 ongoing tracks 应该先保证日常连续性，冷层更适合做关系拓扑、时间拓扑和深层归档。

当前私人压测里，睡前 dreaming 仍主要由外部后台 scheduler 负责触发，Bridge 提供 WeChat 上文、图片、工具写入和共享数据仓。Bridge 自身已经有 reminder / random checkin 的 system-turn 队列，但还没有完全独立的 nightly dreaming executor。因此独立发布前要把 dreaming 明确做成 Bridge-owned、runtime-neutral 的后台能力：Codex 和 Claude Code 都只是可选执行器，不能让“有没有外部进程打开”决定它会不会整理记忆。

公开前还需要继续验证：

- dreaming 在用户静默后能稳定触发。
- 没有外部 scheduler 进程时，Bridge 自己也能按静默窗口触发 nightly dreaming，并把结果写入本地 `dreaming_mutation_log` / `warm_memory` / `memory_tree`。
- dreaming 的完成状态必须由真实 mutation/writeback 成功决定；若只是 scheduler 碰到任务、模型未返回、JSON 解析失败、warm/cold 写入失败或用户仍在前台活跃，都不能标记完成。
- dreaming 失败或被静默窗口 hold 时，必须延迟重试同一任务（默认可参考 20 分钟），保留 `retry_count`、`retry_after`、`last_status`、`last_error` 这类可审计字段，直到成功或用户/维护者明确介入。
- Codex runtime 与 Claude Code runtime 都能执行同一份 dreaming JSON 契约；若某个 runtime 暂不可用，要给用户可见但不入记忆的故障报告。
- dreaming 产出的 `memory_metabolism`、warm/cold mutation、cold patch 或 batch promotion 不能只停在 executor 内部，必须进入可审计日志或回执。
- dreaming prompt 只能整理记忆，不能把前台人格整理成冷冰冰的工作报告，也不能生成关键词式表达限制。
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
- Codex 和 Claude Code 各跑一次最小链路。
- 主动 wakeup、reminder、sticker、附件 inbox、memory tool 都跑一轮。

### 5. 外源记忆导入还没隔离验收

GPT / Rikkahub / Driftstone / Notion staging 这类外源记忆导入还没有在独立 Mossbridge data root 中验收。

目前主要障碍是：私测 bridge 与私人母库共用数据根时，外源导入会污染正在使用的真实记忆仓，无法判断导入器、召回链路、dreaming 整理到底是不是独立可靠。

公开前需要单独验证：

- 原始对话切片进入 conversation cache 或 episode journal。
- 归一化后的稳定事实进入 warm memory。
- 可拓扑化的人物、关系、地点、长期项目进入 cold tree/provider。
- 重复卡、错误身高等旧误差能被导入前清洗或导入后修正。
- 导入测试数据与真实稳定记忆可分离、可删除、可重跑。

### 6. 隐私清洗还没做终检

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

- 已将 package name 改为 `mossbridge`。
- 已将 CLI 命令改为 `mossbridge`。
- 已将 MCP server namespace 改为 `mossbridge_tools`。
- 已将工具名前缀迁移到 `mossbridge_*`。
- 已将默认状态目录迁移到 `${HOME}/.mossbridge`。
- 已将公开环境变量前缀迁移到 `MOSSBRIDGE_*`。
- 不提供旧 `ASHERIEBRIDGE_*` 运行时兼容入口；公开仓只接受 `MOSSBRIDGE_*`。历史前缀只应出现在迁移说明或来源说明里，避免新部署混淆。

### 数据仓独立化

- 新建默认数据仓模板。
- 写清楚 data root 目录结构。
- 确认测试数据与稳定记忆分离。
- 确认自定义 stickers、inbox、logs、accounts 永远不会进入 git。
- 提供空仓启动 smoke test。
- 提供迁移旧数据的说明，但不把私人外部记忆仓作为默认依赖。

### 记忆系统补强

- 完成 ongoing tracks 到 warm memory 的整理链路。
- 完成跨窗口 conversation cache 到 dreaming 的整理链路。
- 完成 Bridge-owned nightly dreaming 触发器，不能依赖私人外部 scheduler。
- 完成 dreaming completion gate：触发只是 attempt，只有 mutation/writeback 成功才 complete；失败或前台活跃时延迟重试同一任务，不悄悄滚到下一天。
- 完成 dreaming 整理回执记录，尤其是 `memory_metabolism`、warm write、cold promotion、cold patch 和失败原因。
- 固定 dreaming 的语气边界：整理记忆时保留自然陪伴质地，不把观察、冷树或温卡变成前台表达禁令。
- 完成外源 GPT/Rikkahub/Notion staging 导入到 warm/cold/episode 的隔离验收。
- 完成 ChatGPT 网页/app daily capture 插件与导入器：先写入独立 `cache/app_daily_captures/`，再归一化进 `conversation_cache`，不能直接污染稳定记忆。
- 给冷层拓扑定义更稳定的 provider 接口。
- 明确 case index 的落盘结构和召回入口。
- 明确 Notion stable memory 与本地 warm/tree/case 的导入导出契约。
- 为 Driftstone/Notion staging 增加归一化层，避免第一轮导出格式直接写进 memory tree。
- 明确官方 app / ChatGPT web daily capture 如何进入 conversation cache。
- 验证主动 wakeup 的 context packet 足够支撑自然对话。
- 避免通过关键词作弊提高个别记忆召回。

### 运行稳定性

- 同一套启动/保活/故障提示必须优先在共享 bridge 层生效，不能只修 Claude Code 路径。
- Codex runtime 需要单独验证 auth/RPC/compact/approval 失败的用户可见提示。
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

- 已写 `docs/quickstart.md`，仍需在新账号/新机器上实跑验收。
- 完善 `.env.example`，并在新机器上验证。
- 写 “第一次扫码登录” 指南。
- 写 “如何绑定 workspace” 指南。
- 写 “如何选择 Codex runtime / Claude Code runtime” 指南。
- 写 “如何切换 Claude 模型” 指南。
- 写 “记忆仓可以不用 / 可以外接 / 可以共享”的说明。
- 写 “Notion 固有记忆同步 / 官方 app 每日抓取”说明。
- 写 “从 Cyberboss 分叉而来，差异在哪里”的公开说明。

## 分享给朋友前的验收标准

可以公开或发给朋友前，至少要满足：

- 在一台没有私人数据的新环境里可以安装启动。
- 不接私人外部记忆仓也可以聊天、提醒、主动唤醒、收发文件。
- 空记忆仓不会报错。
- 新用户可以看 README 跑完登录、绑定、启动。
- 朋友不需要理解你的私人记忆结构也能使用基础 bridge。
- 所有私人路径、截图、账号、日志和记忆都已经清除。
- 公开仓里的名字统一为 Mossbridge，或文档清楚解释历史兼容名。

## 现在的维护策略

当前阶段仍以私有优化为主：

- 继续在现有本地仓位上实测 WeChat 日常对话。
- 当前 live 测试仓继续保持原路径和原 service，不在上面做公开版大重命名。
- `0-github/Mossbridge` 作为公开版孵化仓，专门用于命名清洗、空仓测试、新微信绑定和外源导入验收。
- 从 live 仓同步功能修复到公开孵化仓时必须显式记录，避免两份代码悄悄分叉。
- 继续把真实发现的问题写入代码和文档。
- 每完成一轮稳定优化，就提交到私有 GitHub 仓库备份。
- 等冷层、dreaming、memory provider 和新用户安装链路稳定后，再做公开前清洗。

Mossbridge 现在像一座已经能走的小桥，但桥边还有脚手架。私有备份保存的是“它已经长出来了”，公开发布要等的是“别人踩上去也不会被脚手架绊倒”。

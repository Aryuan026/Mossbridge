# Mossbridge Built-In Brain Boundary

Mossbridge 第一阶段不是空桥外挂脑。它应该能自己部署、自己写入、自己递送记忆；只是还不急着把更成熟的私人记忆代谢系统拆成独立公开包。

所以当前目标是：让 bridge 自带 brain，同时把 brain 和嘴、手、runtime engine 分开。以后修 WeChat 发送、模型切换或工具提示时，不应该顺手改坏保存下来的用户记忆。

## Code Areas

把代码想成四个区域：

- 嘴：`src/adapters/channel/weixin/`
  负责微信登录、收消息、发消息、附件入口和桥层提示。
- 发动机：`src/adapters/runtime/codex/`、`src/adapters/runtime/claudecode/`
  负责 Codex / Claude Code 的协议、session、model catalog、进程/RPC 细节。
- 手：`src/tools/` 和非记忆 `src/services/`
  负责文件、提醒、贴纸、timeline、状态检查等可调用能力。
- 脑：`src/asherie/`、`src/services/asherie-memory-service.js`、`src/asherie/storage-layout.js`
  负责记忆布局、召回、上下文包、写入权威、热记忆、温记忆、case 和拓扑候选。

`src/brain/README.md` 是边界标记。现在先不大搬目录，因为 `src/asherie/` 里有已经验证过的记忆代码；后续 rename 必须作为迁移做，而不是一次搜索替换。

## Write Rule

嘴、手、runtime adapter 不直接写 `MOSSBRIDGE_DATA_ROOT` 里的 brain 文件。

如果它们需要保存东西，应通过 memory service、service domain 或 project tool 进入。这样数据布局、identity scope、case refs 和 future migration 才不会因为某个通道修复被打散。

## Data Routes

| Material | First Landing Zone | Notes |
| --- | --- | --- |
| 微信/ChatGPT 刚聊完的上下文尾巴 | `cache/conversation_cache/` 和 `cache/hot/` | 近期素材，不是稳定事实 |
| ChatGPT web/app 每日抓取 | `cache/app_daily_captures/` | 先验 schema，再归一化，不直写温卡 |
| 小事记、轻量日记、随手备注 | `storage/notebook/` | 人能读的原材料层 |
| 还没结束的事 | `storage/ongoing_tracks.json` | 让它保持浮在前台 |
| 有起止的小故事/照片/旅行/小任务 | `storage/episode_journal/` | 可导出、可回看，可被温卡引用 |
| 项目、代码、部署、文件、决策、测试 | `storage/case_index/` | 工作日志和 case memory |
| 稳定偏好、关系锚点、长期连续性 | `storage/warm_memory/` | 前台最常用的稳定记忆 |
| 卡与卡为何相连、关系分支、证据边 | `storage/memory_tree/` | 拓扑，不是全文归档 |
| 后台经验、选择沉默的理由、维护复盘 | `storage/solitude_journal/` | 默认不塞进自然聊天 |

## 小事记和 Case 的区别

小事记像桌上的便签。它可以很轻：今天发生了什么、用户随手说了什么、某个片刻值得留一下。它默认不代表长期事实，也不需要立刻进入温记忆。

Case 像工作档案。只要涉及文件、代码、部署、产物、测试、决策或可复盘的任务，就应该进入 `case_index`。Case 可以把稳定经验沉淀成温卡，但温卡要带 `case_refs`，不要复制整段工作流水。

Episode 介于两者之间：如果一个小事记长成了有起止的故事，例如旅行、照片分享、一次家庭事件、一个短任务，就放进 `episode_journal`，再由 dreaming 或前台工具决定是否抽出温卡。

## Hot Memory

热记忆不是另一个长期仓。它是刚发生、还带体温的上下文缓冲层：

- `cache/hot/context_basin/` 保存临近窗口的上下文素材。
- `cache/hot/projections/` 保存给当前 runtime 的短投影。
- `cache/hot/snapshots/` 保存某次合流前后的快照。
- `cache/hot/upstream_context_merge/` 预留给 ChatGPT/web/app 捕获合流。

未来 ChatGPT 网页抓取插件应该先把 raw daily capture 放到 `cache/app_daily_captures/`，再整理进 `conversation_cache` 和 hot basin。只有经过本地整理、确认和引用的内容，才进入 warm、ongoing、episode 或 case。

## Public First Version

公开第一版先承诺这件事：Mossbridge clone 后有自己的本地 brain，能空仓启动，能写温记忆和 ongoing，能保留 notebook/case/episode 的位置，能把记忆递给 Codex 或 Claude Code。

外源 GPT / Rikkahub / Driftstone / Notion / ChatGPT capture 都是后续入口。它们应该接入这套 data route，而不是绕过 Mossbridge 的 brain 边界。

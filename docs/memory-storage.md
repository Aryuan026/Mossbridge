# Bridge Memory Storage

这份文档说明 bridge 自己的记忆仓应该怎么摆放、怎么和既有本地记忆仓共用或拆开，以及哪些层适合日常对话，哪些层只适合做长期归档。

它的目标不是规定模型怎么说话，而是把数据边界讲清楚：代码本体、用户数据、测试数据、共享数据、可迁移数据必须能分开。

## 核心判断

Bridge 可以作为独立产品运行，不应该默认依赖私人外部冷层树才能完成日常陪伴。

当前推荐：

- 日常关系、口吻、偏好、象征物、用户固定印象、近期待办，优先进入 `warm_memory/` 和 `ongoing_tracks.json`。
- 既有私人冷层树可以作为迁移/兼容来源、深层归档、关系拓扑和时间拓扑参考，但不作为 WeChat 日常人格连续性的主要文本召回层。
- Mossbridge 不提供私人外部执行器接口：不桥接不可公开的外部执行器。公开线需要的简单能力应成为 Mossbridge 本体能力或清晰的可选 adapter。
- 第一版公开路径是 `WeChat -> Mossbridge memory delivery -> Codex/Claude Code runtime -> WeChat 延续`。ChatGPT 网页/app daily capture、多端同步和 Notion 对齐先作为后续扩展，不进入第一版启动链路。
- Bridge 的冷层不应该只是另一套温卡检索器。它更适合保存“卡与卡之间为什么连在一起”：家族分支、关系网、跨时间因果、证据来源，以及 case/file-work provenance。
- 231 张来自旧冷层、实际语义更像温卡的内容，迁入 bridge 时应作为温层材料处理。

一句话：温层管“我们怎么连续地生活和说话”，冷层拓扑管“这些人和事为什么在同一张地图上”，案例索引管“我帮你做过什么事”。

## 存储根目录

默认数据根由环境变量控制：

```dotenv
MOSSBRIDGE_DATA_ROOT=/absolute/path/to/bridge-data
```

如果不设置，bridge 会落在本地状态目录下的 `mossbridge_data/`。公开部署仍建议显式设置 `MOSSBRIDGE_DATA_ROOT`，这样后续迁移、备份和测试隔离更清楚。

常用可覆盖路径：

```dotenv
MOSSBRIDGE_ASHERIE_WARM_MEMORY_DIR=/absolute/path/to/warm_memory
MOSSBRIDGE_ASHERIE_OBSERVATION_JOURNAL_DIR=/absolute/path/to/observation_journal
MOSSBRIDGE_ASHERIE_EPISODE_JOURNAL_DIR=/absolute/path/to/episode_journal
MOSSBRIDGE_ASHERIE_TRUTH_LAYER_DIR=/absolute/path/to/truth_layer
MOSSBRIDGE_ASHERIE_MEMORY_VERSION_BANK_DIR=/absolute/path/to/memory_versions
```

这些覆盖项用于兼容既有本地记忆仓或迁移旧数据。新部署优先只设置 `MOSSBRIDGE_DATA_ROOT`，让 bridge 自己生成清晰的数据仓。

## 分层地图

### `storage/warm_memory/`

温记忆。这里是 bridge 日常对话最重要的记忆区。

适合放：

- 用户稳定偏好、长期习惯、关系锚点
- 重要象征物，例如一件首饰、一句话、一段共同经历
- 可反复调用的人际背景和家庭关系
- 已经稳定下来的自我印象、伴侣印象、协作风格
- 从旧冷层迁入、但本质上是陪伴型记忆卡的材料

长期必须常驻的卡应显式标记：

```json
{
  "pinned": true,
  "certainty_state": "anchor"
}
```

### `storage/ongoing_tracks.json`

近中期追踪。它不是固定日历，也不是永久人格事实，而是“这阵子还活着的事”。

适合放：

- 减重、身体状态、用药观察
- 两周内要写完的稿子
- 悬而未决的咨询或购买决策
- 最近还在推进的系统 bug
- 家族八卦、关系进展、还没有收尾的现实事件

一条 ongoing track 应该保留：

- `title`: 人能看懂的短标题
- `kind`: 例如 `health`、`writing`、`family`、`system`、`shopping`
- `status`: `active`、`paused`、`blocked`、`done`、`archived`
- `summary`: 当前进展
- `next_step`: 下一步，如果有
- `why_it_matters`: 为什么这件事应该继续浮在前台
- `progress_log`: 带时间戳的事实进展
- `shadow_snippets`: 少量近期原话尾巴，用来保留语气和接续感
- `last_touched_at`: 最近一次被真正触碰的时间

ongoing 的重点是事件连续性，不是窗口来源。用户可能因为传文件方便才换到另一个窗口，事件本身不应该被拆开。

### `storage/solitude_journal/`

AI 的独处日志。它不是给用户贴标签，也不是普通聊天记录，而是给后台唤醒、维护窗口、dreaming 后检查和 case 复盘留下“我刚刚想明白了什么”的可回看摘要。

适合放：

- 随机唤醒后没有必要打扰用户，但值得未来自己记住的判断
- 某次维护、失败、卡顿、上下文过载之后形成的经验
- 对下一步系统演化的候选想法，例如“需要更好的图片批处理等待”
- 需要未来开 case 或联系用户讨论的能力缺口
- 选择沉默的具体理由，而不是空白消失

不适合放：

- 原始隐藏思维链或逐 token 推理
- 账号、密钥、权限、登录态等敏感信息
- 运行报错的噪声全文；报错应进诊断日志，solitude 只留经验摘要
- 用户固定印象；那应写进 `observation_journal`
- 真实工作产物和 artifact；那应写进 `case_index`

一条 solitude entry 应该保留 `summary`、`reasoning_summary`、`evidence`、`lesson`、`next_actions`、`proposed_changes`、`contact_user`、`related_case_ids` 和 `confidence`。如果 AI 认为某个思考需要跟用户展开，可以把 `contact_user` 标成 `wechat`、`later` 或 `ask_user`，但发送本身仍要走 Mossbridge 已安装的本体渠道并遵守用户可见回执。

solitude 不会默认塞进每轮自然聊天。Bridge 会在后台唤醒、维护窗口、或用户明确询问独处笔记/后台经验时构造轻量 `solitude-digest`：近期经验影响“要不要打扰、是否先维护、是否需要联系用户/开 case”，重复出现的 `lesson/tags/next_actions` 会形成后台经验权重；只有被反复验证且与用户长期偏好有关的内容，才应该由 dreaming 或前台工具晋升到 `observation_journal` / `warm_memory` / `case_index`。

### `storage/observation_journal/`

观察日记。它是 `timeline` / `diary` 和 `warm_memory` 中间的一层，用来保存“相处中形成的默契”，而不是给用户贴死标签。

如果 Bridge 和另一个本地前台共用同一个 `MOSSBRIDGE_DATA_ROOT`，这里就是共享观察簿；微信、其他前台、后台唤醒和 dreaming 都应该把观察投到这一层，而不是各自养一套“用户印象”。Bridge 独立部署时也可以使用同一套目录结构，只是共享仓换成自己的 `MossbridgeData`。

适合放：

- 最近状态和生活节律，例如“早上刚醒时更适合轻一点的唤醒”
- 反复出现但还不够稳定的习惯
- 用户明确表达过的不舒服边界
- 图片、行程、上下文尾巴中推出来的轻量观察
- 未来回复或主动唤醒可参考的相处方式

前台模型不需要等用户点名才写观察。只要它认为某个轻量模式会帮助未来连续性，就可以静默写入；但每条都必须保留证据、置信度和可纠正状态，不能变成“用户就是这样”的定论。

不适合放：

- 医疗、心理、性格定论
- 没有证据的强判断
- 已经被用户否定但还继续影响回复的旧印象
- 应该写进 `ongoing_tracks` 的具体任务进度
- 已经稳定到应成为长期事实的温记忆卡

一条 observation 应该保留：

- `observation`: 当前观察本身
- `kind`: `life_rhythm`、`recent_state`、`habit`、`boundary`、`preference`、`work_style` 等宽分类
- `confidence`: 0 到 1，默认应该偏低
- `evidence`: 简短证据或来源描述
- `inference`: 从证据推出来的部分，必须和事实分开
- `suggested_use`: 未来回复、唤醒或生活建议中怎么温柔地使用
- `status`: `active`、`tentative`、`corrected`、`rejected`、`stale`、`promoted`
- `corrections`: 用户纠正或系统修正的记录

如果用户说“你不要这样我生气了”“这个观察不对”，对应 observation 必须被修正、降置信度或标成 `rejected`。观察日记允许错，但不允许错了还偷偷继续控制前台回复。

它的召回权重应该低于明确温卡和 active ongoing，但高于纯原始流水。它解决的是省上下文架构里“默契不容易自然积累”的问题。

### `storage/episode_journal/`

事件簿。它是给“有起止、适合回头整理成人类小记录”的内容准备的相册盒子，例如一次旅行、一个周末、一段照片分享、一次小任务、一次装修看图、一次亲友聚会。

它不是永久事实卡，也不是普通 ongoing。ongoing 负责“这件事还活着，要继续挂着”；episode journal 负责“这段已经或即将形成一个可回看的故事”。

适合放：

- 旅行三天的每日尾巴和照片说明
- 一组微信照片、附件路径和 paired attachment note
- 顺利/不顺利、快乐/麻烦、场景变化、当时情绪
- 批量导入的 RikkaHub / app 对话尾巴后处理摘要
- 最终可导出为日记、周记、相册文案或 Obsidian 页面的小记录

目录形态：

```text
storage/episode_journal/<scoped_user_id>/<episode_id>/
  episode.json
  entries.jsonl
  episode.md
```

`episode.md` 是人类可读导出层。UI 可以直接渲染 JSON，也可以把 Markdown 作为 Obsidian 对接的第一版。

运行时如果当前轮带有图片/附件，或者检索命中了活动中的 episode，Bridge 会递送一条轻量 `episode-attention` 提示。它只提醒前台模型“旁边有这个盒子”，不替前台模型强制写入。如果前台从 episode 中沉淀出一张长期可复用的温记忆卡，温卡应写入 `episode_refs` 指向对应 `episode_id`，像 case refs 一样保留回看路径。

Episode 可以携带 `topology_refs`，用于生成候选冷层边，而不是直接写冷事实：

```json
{
  "people": ["同行的人"],
  "places": ["河南", "洛阳"],
  "activities": ["看打铁花", "拍照"],
  "objects": ["某个象征物"],
  "themes": ["旅行节奏", "拍照偏好"],
  "relationship_roots": ["person::... 或 branch::..."],
  "warm_refs": ["warm-card-id"],
  "case_refs": ["case-id"]
}
```

这条链路的边界是：episode 保存故事盒子，`topology_refs` 只保存已知结构；冷层后续可以审查这些 candidate edge，但不要把“旅行全文”直接推进冷树。

### `cache/conversation_cache/`

近期对话沉淀池。第一版主要由 WeChat 和本地 runtime 写入；后续 ChatGPT 网页/app daily capture 或其他 chatbox 可以作为数据源接进这里。

它不是每轮都要完整塞给前台模型的全文聊天记录。运行时应该从这里整理出可读工作包，而不是盲目复读。

日常注入通常由这些部分组成：

- resident warm anchors
- relevant warm cards
- active ongoing tracks
- recent tail snippets
- 最近少量对话切片
- 必要时再加 case refs 或冷层引用

### `cache/app_daily_captures/`

后续官方 app / ChatGPT web 抓取插件的每日对话入口。第一版不启用同步，只保留目录和验证契约作为未来扩展位。

它解决的是“官方 app 端的上文怎么进入沉淀池”，不是“固有记忆怎么长期同步”。推荐一日一个目录，先保存 raw/daily capture，再归一化进 `conversation_cache/`。

这个目录可以接浏览器插件、网页抓取脚本或官方导出的每日对话记录。进入这里的内容默认是近期素材，不是稳定记忆。

### `storage/memory_versions/`

旧版记忆包兼容层。当前代码里仍然支持 `persona_memos`、`hard_facts`、`case_updates`。

其中 `case_updates` 可以被索引成 case-like 记录，但它还不是一套独立、清晰的案例仓产品层。后续如果做 `case_index/`，可以把这里当作导入来源或兼容来源。

### `storage/memory_tree/`

Bridge 自己的轻量关系树预留位。

它不是私人外部冷树的完整复制，也不要求第一阶段就变成图数据库。它的目标是让独立部署的 Mossbridge 也能保存少量明确关系：

- 哪两张温卡应该一起出现
- 某个人物属于哪个关系分支
- 某个象征物和哪段关系/事件有关
- 某个 case 和哪些文件、决定、后续问题有关
- 这条边来自哪些证据卡，可信度是什么

第一阶段可以用 JSON 文件保存 node / edge / evidence。等召回链路稳定后，再考虑索引和自动生成。

### `storage/truth_layer/`

冷层或真值树。这个目录可以接迁移来的旧 `truth_layer`，也可以留给 bridge 自己。

当前 bridge 的推荐使用方式：

- 可读，但不强依赖。
- 可用于深层事实、历史归档、关系拓扑、时间拓扑、兼容旧冷层。
- 不负责日常人格连续性。
- 不应该把所有关系记忆都压进这里再期待它主动浮现。

如果冷层召回不稳定，bridge 仍应能依靠温层、ongoing 和近期尾巴正常对话。

冷层真正不可替代的价值不是“多存一份文字”，而是结构关系。

例如：

```text
阿鸢姥姥家 branch
  -> 家庭气氛 / 关系模式 / 代际习惯
  -> 妹妹 node
  -> 最近事件 / 性格表现 / 可能受影响的地方
```

如果只有温卡，系统可能分别召回“姥姥家”和“妹妹”，但不一定知道它们应该一起解释。冷层拓扑应该让 runtime 在命中“妹妹”时能顺手扩一跳到“阿鸢姥姥家”，再把分支气氛作为背景材料交给前台模型。

这个扩展不应该把推测包装成事实。前台模型可以说“这可能和姥姥家那边的气氛有关”，但不能把关系拓扑直接变成未经证实的性格定论。

### `storage/case_index/`

推荐的新案例索引层。它记录“系统帮用户做过什么工作”，而不是“用户是谁”。

适合放：

- 一个项目或 bug 的处理过程
- 改过的文件、关键命令、测试结果
- 某次架构判断为什么这么定
- 某个办公协同任务产出了什么文档
- 一个部署问题最后怎么解决

建议 schema：

```json
{
  "case_id": "wechat-bridge-memory-storage-2026-05-01",
  "title": "Bridge memory storage split",
  "kind": "system_architecture",
  "status": "active",
  "summary": "Clarified that bridge should use warm memory for daily continuity and reserve cold/case space for work provenance.",
  "user_goal": "Make bridge deployable without confusing private cold-layer experiments.",
  "actions": [],
  "artifacts": [],
  "changed_files": [],
  "tests": [],
  "decisions": [],
  "followups": [],
  "source_refs": [],
  "agent_id": "moss",
  "owner_id": "owner",
  "created_at": "2026-05-01T00:00:00.000Z",
  "updated_at": "2026-05-01T00:00:00.000Z"
}
```

Case index 不应该在每轮亲密闲聊里强行注入。它更适合在用户问“你之前怎么修的”“那个项目在哪”“我们做过哪些 case”时被召回。

如果某张温卡是从一个 case 中沉淀出来的长期经验、偏好或系统结论，应在温卡上写 `case_refs`。如果这张温卡后续进入冷层，promotion 必须保留 `case_refs`，让冷根能回看对应 case，而不是把工程细节复制进冷树。

#### 终稿与云端归档边界

Case 可以有很多中间产物，但 AI 不负责判定哪一版是终稿。`artifact.status` 可以区分 `scratch` / `working` / `candidate` / `user_approved_final` / `discarded`；只有用户明确确认或重新发回的文件，才可以标成 `user_approved_final`。

当 case 准备结束时，前台或 worker 应提醒用户：请把认可的终稿发回，或明确说哪一个 artifact 是终稿。Bridge 只记录这个终稿的本地路径、hash/大小/时间、`final_artifact_id` 和人类可读储存编号；Notion、iMa、Obsidian、网盘等云端归档由用户手动上传，系统不要自动同步“疑似终稿”。

中间临时文件默认只是工作区草稿。只有在用户确认终稿已收齐、可清理后，系统才可以进入清理流程；清理前应保留 case ledger、事件摘要、正式产物引用、必要测试/决策，以及指向冷记忆树或 warm card 的 `case_refs`。冷树挂载的是终稿编号、case 摘要和结构关系，不是 worker 的全过程草稿。

### `storage/notion_sync/`

后续 Notion 固有记忆同步层。第一版不启用 Notion 同步，也不要求部署者配置 Notion。

它对齐 Driftstone 的 Notion staging bundle：

```text
00_manifest.json
01_memory_entries.json
02_source_topics.json
03_persona_workspace_snapshot.json
```

推荐职责：

- `memory_entries` 作为跨端稳定记忆表。
- `source_topics` 作为来源话题索引和证据索引。
- `persona_workspace` 作为稳定人格/工作台快照。
- 本地 `warm_memory`、`memory_tree`、`case_index` 从 Notion stable memory 周期性导入。
- 本地 dreaming 确认后的固有记忆进入 export queue，等待写回 Notion。

更完整的同步契约见 [docs/notion-memory-interop.md](./notion-memory-interop.md)。

## 冷层不是另一套温卡

Bridge 后续更健康的形态是“温卡存内容，冷层存结构”。

温层卡片可以记录：

- 妹妹最近发生了什么
- 用户怎么看这件事
- 阿霁当时怎么回应
- 这张卡能直接给前台模型看的摘要

冷层拓扑可以记录：

- 妹妹属于哪个关系分支
- 她和哪些人、事件、地点、旧卡有关
- 这个关系来自哪些证据卡
- 这个关系是稳定事实、弱关联，还是待确认推测
- 这个分支跨时间发生过哪些变化

建议的关系边形状：

```json
{
  "edge_id": "edge-family-a-yuan-grandmother-home-sister",
  "from_node_id": "person:sister",
  "to_node_id": "branch:a-yuan-grandmother-home",
  "relation_type": "belongs_to_family_branch",
  "evidence_card_ids": ["warm-card-001", "warm-card-087"],
  "confidence": "observed",
  "notes": "Used to expand sister-related recall into the grandmother-home branch when relevant.",
  "created_at": "2026-05-01T00:00:00.000Z",
  "updated_at": "2026-05-01T00:00:00.000Z"
}
```

日常召回可以按这个顺序走：

```text
user query / live context
  -> warm recall finds direct cards
  -> topology expands one or two relevant hops
  -> runtime injects a compact relationship-context packet
  -> foreground model decides how much to use
```

这样冷层不是压住模型的另一套硬规则，而是把散落的温卡串成一张路网。

Bridge 当前消费契约：

- `sql_roots/latest.json` 仍用于先找候选根。
- `sql_vines/latest.json` 或 `sql_vines/runtime/latest.json` 用于从候选根扩一跳关系。
- `by_root` 形状和 `edges` 形状都应该能被读取。
- 注入给前台时只给紧凑的 `cold-vine` 行，不把整张图谱塞进上下文。
- 如果某个关系分支没有被扩出来，先检查外部冷层 vine 里是否真的存在对应边，而不是只调大 bridge 注入量。

## 231 张旧冷层温卡怎么迁

这里最容易长出同步问题，所以规则要很朴素：同一层记忆只能有一个写入权威。

### 独立 bridge 模式

如果 bridge 要独立部署或分享给别人，推荐把 231 张旧冷层温卡导入 bridge 自己的 `storage/warm_memory/`，作为一次可追踪快照。

同时，从这些卡里抽取出的家族分支、人物关系、跨时间因果，可以进入冷层拓扑。内容不要双写，结构可以引用温卡。

每张导入卡建议带上：

```json
{
  "source_system": "legacy_memory_system",
  "source_layer": "truth_layer",
  "source_card_id": "original-id",
  "import_batch": "2026-05-bridge-warm-import",
  "imported_at": "2026-05-01T00:00:00.000Z",
  "agent_id": "moss",
  "owner_id": "owner"
}
```

导入后，bridge 的温层就是 bridge 自己的源头。外部系统后续怎么优化冷层，不会自动覆盖 bridge。

### 共享记忆模式

如果目标是 WeChat、ChatGPT 网页/app、终端和第三方 chatbox 共享同一个大脑，就不要复制两份温卡。

做法是让 bridge 直接读取同一份温层目录：

```dotenv
MOSSBRIDGE_ASHERIE_WARM_MEMORY_DIR=/absolute/path/to/shared-data/storage/warm_memory
```

这时写入权威也要明确。推荐让所有窗口共同写同一个 Mossbridge-compatible 温层仓，而不是 bridge 写自己的副本、另一个前端又写另一份副本。

### 不推荐的状态

不推荐：

- 另一个前台有一份温卡，bridge 又复制一份，双方都继续写。
- 冷层里放温卡，温层里也放同一张卡，但没有 `source_card_id` 或同步记录。
- 测试数据和真实使用数据混在同一个 owner/agent 作用域里。

这种状态短期能跑，长期会出现“同一件事两张卡、两个版本、两个阿霁都觉得自己是真的”。

## Dreaming 与记忆代谢

推荐链路：

```text
conversation_cache -> dreaming -> warm_memory / ongoing_tracks / episode_journal / case_index
```

默认规则：

- 对话里的稳定关系、偏好、象征物，进入温层。
- 短中期活跃事件，进入 ongoing。
- 有起止、适合整理成人类小记录的旅行/照片/小任务，进入 episode journal。
- 近期状态、日常节律和相处默契，先进入 observation journal。
- 已完成的工程、文件工作、调试结论，进入 case index。
- 后续如果启用官方 app / ChatGPT web 每日抓取，先进入 `app_daily_captures`，再归一化进 `conversation_cache`。
- 后续如果启用跨端固有记忆，再通过 `notion_sync` 与 Notion 的 `memory_entries` / `source_topics` 对齐。
- 半年仍反复出现并稳定下来的 ongoing，可再整理成温层事实或 case 总结。
- 不要把短期事件默认推进冷层。

如果 bridge 和另一个本地前台共用 `conversation_cache`，dreaming 应该按事件和时间窗口整理，而不是按“来自微信/来自某个前端”切开。

输入契约：

- `conversation_cache` 是 dreaming 的主水管；`hot_context_projection` / cross-window tail 只能做兜底，避免前端刚聊过但 canonical cache 漏写时整晚看不见。
- `focus_record_refs` 必须来自本轮真实递送过的 record id。模型输出的 `cap_...` 需要后台校验，差一位可纠偏，校不回来的要丢掉，不能写进 mutation log 或温卡。
- 外部工具错误、授权报错、广告通知这类 transport noise 不应该进入 warm card，只能留在诊断日志。

## Agent 与 owner

部署时必须把代码本体和使用数据分开。

最少需要区分：

- `owner_id`: 这份记忆属于谁
- `agent_id`: 当前前台人格或助手是谁
- `realm_id`: 使用场景或作用域，例如 `default`
- `source_system`: 记忆从哪个系统导入
- `source_layer`: 原始层级
- `test_run_id`: 如果是测试数据，必须能清掉

`agent_id` 未来要可改。分享 bridge 给别人时，应该能带走代码和空仓结构，不带走原用户的记忆、测试记录、微信账号、Claude/Codex 会话。

## 分享部署时应该带什么

应该带：

- 空的目录结构说明
- 示例 `.env`
- 这份记忆仓文档
- 不含个人内容的示例卡

不应该带：

- 微信账号文件
- 会话和 thread id
- `conversation_cache`
- 真实 warm memory
- raw transcript
- dreaming mutation log
- 用户图片、附件、办公文件

Bridge 可以越长越像独立产品，但它必须有一条很清楚的脊椎：代码可分享，记忆归用户。

新部署给 Codex 的具体施工说明见 [docs/codex-memory-setup.md](./codex-memory-setup.md)。

# Bridge Memory Storage

这份文档说明 bridge 自己的记忆仓应该怎么摆放、怎么和 AsherieHome 共用或拆开，以及哪些层适合日常对话，哪些层只适合做长期归档。

它的目标不是规定模型怎么说话，而是把数据边界讲清楚：代码本体、用户数据、测试数据、共享数据、可迁移数据必须能分开。

## 核心判断

Bridge 可以作为独立产品运行，不应该默认依赖 Home 的冷层树才能完成日常陪伴。

当前推荐：

- 日常关系、口吻、偏好、象征物、用户固定印象、近期待办，优先进入 `warm_memory/` 和 `ongoing_tracks.json`。
- Home 的冷层树可以继续作为兼容层、深层归档、关系拓扑和时间拓扑，但不作为 WeChat 日常人格连续性的主要文本召回层。
- Bridge 的冷层不应该只是另一套温卡检索器。它更适合保存“卡与卡之间为什么连在一起”：家族分支、关系网、跨时间因果、证据来源，以及 case/file-work provenance。
- 231 张来自旧冷层、实际语义更像温卡的内容，迁入 bridge 时应作为温层材料处理。

一句话：温层管“我们怎么连续地生活和说话”，冷层拓扑管“这些人和事为什么在同一张地图上”，案例索引管“我帮你做过什么事”。

## 存储根目录

默认数据根由环境变量控制：

```dotenv
ASHERIEBRIDGE_DATA_ROOT=/absolute/path/to/bridge-data
```

如果不设置，bridge 会落在本地状态目录下的 `asherie_gateway/`。

常用可覆盖路径：

```dotenv
ASHERIEBRIDGE_ASHERIE_WARM_MEMORY_DIR=/absolute/path/to/warm_memory
ASHERIEBRIDGE_ASHERIE_TRUTH_LAYER_DIR=/absolute/path/to/truth_layer
ASHERIEBRIDGE_ASHERIE_MEMORY_VERSION_BANK_DIR=/absolute/path/to/memory_versions
```

这些覆盖项用于兼容 Home 或迁移旧数据。新部署优先只设置 `ASHERIEBRIDGE_DATA_ROOT`，让 bridge 自己生成清晰的数据仓。

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

### `cache/conversation_cache/`

近期对话沉淀池。WeChat、终端、Home 前端或其他窗口都可以把上文写进这里，供 dreaming 和后续抽取使用。

它不是每轮都要完整塞给前台模型的全文聊天记录。运行时应该从这里整理出可读工作包，而不是盲目复读。

日常注入通常由这些部分组成：

- resident warm anchors
- relevant warm cards
- active ongoing tracks
- recent tail snippets
- 最近少量对话切片
- 必要时再加 case refs 或冷层引用

### `cache/app_daily_captures/`

官方 app / ChatGPT web 抓取插件的每日对话入口。

它解决的是“官方 app 端的上文怎么进入沉淀池”，不是“固有记忆怎么长期同步”。推荐一日一个目录，先保存 raw/daily capture，再归一化进 `conversation_cache/`。

这个目录可以接浏览器插件、网页抓取脚本或官方导出的每日对话记录。进入这里的内容默认是近期素材，不是稳定记忆。

### `storage/memory_versions/`

旧版记忆包兼容层。当前代码里仍然支持 `persona_memos`、`hard_facts`、`case_updates`。

其中 `case_updates` 可以被索引成 case-like 记录，但它还不是一套独立、清晰的案例仓产品层。后续如果做 `case_index/`，可以把这里当作导入来源或兼容来源。

### `storage/memory_tree/`

Bridge 自己的轻量关系树预留位。

它不是 Home 冷树的完整复制，也不要求第一阶段就变成图数据库。它的目标是让独立部署的 Mossbridge 也能保存少量明确关系：

- 哪两张温卡应该一起出现
- 某个人物属于哪个关系分支
- 某个象征物和哪段关系/事件有关
- 某个 case 和哪些文件、决定、后续问题有关
- 这条边来自哪些证据卡，可信度是什么

第一阶段可以用 JSON 文件保存 node / edge / evidence。等召回链路稳定后，再考虑索引和自动生成。

### `storage/truth_layer/`

冷层或真值树。这个目录可以接 Home 的 `knowledge_tree/data/truth_layer`，也可以留给 bridge 自己。

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
  "user_goal": "Make bridge deployable without confusing Home cold-layer experiments.",
  "actions": [],
  "artifacts": [],
  "changed_files": [],
  "tests": [],
  "decisions": [],
  "followups": [],
  "source_refs": [],
  "agent_id": "aji",
  "owner_id": "owner",
  "created_at": "2026-05-01T00:00:00.000Z",
  "updated_at": "2026-05-01T00:00:00.000Z"
}
```

Case index 不应该在每轮亲密闲聊里强行注入。它更适合在用户问“你之前怎么修的”“那个项目在哪”“我们做过哪些 case”时被召回。

### `storage/notion_sync/`

Notion 固有记忆同步层。

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
- 如果某个关系分支没有被扩出来，先检查 Home 的 vine 里是否真的存在对应边，而不是只调大 bridge 注入量。

## 231 张旧冷层温卡怎么迁

这里最容易长出同步问题，所以规则要很朴素：同一层记忆只能有一个写入权威。

### 独立 bridge 模式

如果 bridge 要独立部署或分享给别人，推荐把 231 张旧冷层温卡导入 bridge 自己的 `storage/warm_memory/`，作为一次可追踪快照。

同时，从这些卡里抽取出的家族分支、人物关系、跨时间因果，可以进入冷层拓扑。内容不要双写，结构可以引用温卡。

每张导入卡建议带上：

```json
{
  "source_system": "asheriehome",
  "source_layer": "truth_layer",
  "source_card_id": "original-id",
  "import_batch": "2026-05-bridge-warm-import",
  "imported_at": "2026-05-01T00:00:00.000Z",
  "agent_id": "aji",
  "owner_id": "owner"
}
```

导入后，bridge 的温层就是 bridge 自己的源头。Home 后续怎么优化冷层，不会自动覆盖 bridge。

### 共享 Home 记忆模式

如果目标是 WeChat、Home 前端、终端和第三方 chatbox 共享同一个大脑，就不要复制两份温卡。

做法是让 bridge 直接读取同一份温层目录：

```dotenv
ASHERIEBRIDGE_ASHERIE_WARM_MEMORY_DIR=/Users/mac/Documents/Codex/AsherieHome/data/storage/warm_memory
```

这时写入权威也要明确。推荐让所有窗口共同写同一个 Home-compatible 温层仓，而不是 bridge 写自己的副本、Home 又写另一份副本。

### 不推荐的状态

不推荐：

- Home 有一份温卡，bridge 又复制一份，双方都继续写。
- 冷层里放温卡，温层里也放同一张卡，但没有 `source_card_id` 或同步记录。
- 测试数据和真实使用数据混在同一个 owner/agent 作用域里。

这种状态短期能跑，长期会出现“同一件事两张卡、两个版本、两个阿霁都觉得自己是真的”。

## Dreaming 与记忆代谢

推荐链路：

```text
conversation_cache -> dreaming -> warm_memory / ongoing_tracks / case_index
```

默认规则：

- 对话里的稳定关系、偏好、象征物，进入温层。
- 短中期活跃事件，进入 ongoing。
- 已完成的工程、文件工作、调试结论，进入 case index。
- 官方 app / ChatGPT web 的每日抓取先进入 `app_daily_captures`，再归一化进 `conversation_cache`。
- 跨端固有记忆通过 `notion_sync` 与 Notion 的 `memory_entries` / `source_topics` 对齐。
- 半年仍反复出现并稳定下来的 ongoing，可再整理成温层事实或 case 总结。
- 不要把短期事件默认推进冷层。

如果 bridge 和 Home 共用 `conversation_cache`，dreaming 应该按事件和时间窗口整理，而不是按“来自微信/来自 Home 前端”切开。

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

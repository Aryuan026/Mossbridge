# Notion Memory Interop

Mossbridge 的长期目标不是只让 WeChat 端记得，也不是只让 Codex 端记得，而是让多个窗口把上文共同沉淀到同一套记忆系统里。

这里的关键判断是：

```text
每日对话流水进入沉淀池。
固有记忆通过 Notion 同步。
本地 runtime 用本地仓快速召回。
官方 app 通过 Notion 工具读写稳定记忆。
```

这样 Codex、WeChat、官方 app 才不是三座孤岛。

## 参考来源

当前对齐参考是本机 Driftstone 最后导出的 Notion staging bundle：

```text
/Users/mac/Documents/Codex/0-github/202604-Driftstone/output/notion_staging/
  ajimem_2025-03/
    00_manifest.json
    01_memory_entries.json
    02_source_topics.json
    03_persona_workspace_snapshot.json
    04_sample_memory_entries.json
```

这套结构的重点是机器可读，而不是只给人看的笔记。

## 三端地图

### WeChat / Mossbridge

负责实时对话、主动唤醒、附件、表情包、短中期上下文和本地快速召回。

写入：

- `cache/conversation_cache/`
- `cache/app_daily_captures/`（如果来源是外部 app 抓取）
- `storage/warm_memory/`
- `storage/ongoing_tracks.json`
- `storage/memory_tree/`
- `storage/case_index/`

### Codex

负责维护代码、整理本地数据仓、跑 dreaming、做迁移和同步脚本。

Codex 不应该把 Notion 当唯一数据库。它应该把 Notion 当作稳定记忆的同步/发布层，把 MossbridgeData 当作运行时本地仓。

### 官方 app / ChatGPT web

如果后续做浏览器插件或网页抓取工具，它负责把每日对话导出成 raw/daily capture，并通过 Notion 工具读取稳定记忆。

它不一定能直接读取 Mossbridge 的本地文件，所以 Notion 是更适合官方 app 端接入的同步面。

## 本地目录

MossbridgeData 里新增两个对齐仓位：

```text
MossbridgeData/
  storage/
    notion_sync/
      bundles/
      memory_entries/
      source_topics/
      persona_workspace/
      export_queue.jsonl
      import_journal.jsonl
      conflicts/
    warm_memory/
    memory_tree/
    case_index/
  cache/
    app_daily_captures/
      chatgpt_web/
        YYYY-MM-DD/
          *.json
    conversation_cache/
```

`storage/notion_sync/` 是固有记忆同步层。

`cache/app_daily_captures/` 是每日对话抓取层。

不要把 daily captures 直接当稳定记忆。它们应该先进入沉淀池，再由 dreaming 或人工审核整理成 warm memory / ongoing / case / memory tree。

## Driftstone Notion Bundle 对齐

### `00_manifest.json`

对应 Mossbridge 的同步批次说明。

建议落地到：

```text
storage/notion_sync/bundles/<bundle_id>/00_manifest.json
```

保留字段：

- `export_kind`
- `export_profile`
- `generated_at`
- `month_hints`
- `counts`
- `suggested_notion_databases`

### `01_memory_entries.json`

这是固有记忆主表，应该对齐 Mossbridge 的 warm/case/tree 三层。

关键字段：

- `entry_id`
- `entry_type`
- `month_key`
- `title`
- `memory_shape`
- `shape_label`
- `summary`
- `content_text`
- `recall_payload`
- `activation_triggers`
- `scene_handles`
- `recall_facts`
- `relationship_meaning`
- `expression_fingerprint`
- `quote_refs`
- `tags`
- `topic_ids`
- `track_id`
- `event_anchor`
- `entity_refs`
- `source_ref`
- `source_window_id`
- `source_window_title`
- `source_msg_range`
- `family_id`
- `family_kind`
- `privacy_codes`
- `quality_flags`

推荐映射：

- `entry_type=persona` 或 `memory_shape` 是自我定义、人物画像、偏好、关系节点时，进入 `storage/warm_memory/`。
- `entry_type=case` 或 `memory_shape=project_line` 时，进入 `storage/case_index/`。
- `topic_ids`、`family_id`、`entity_refs`、`event_anchor` 可生成 `storage/memory_tree/` 的 node/edge/evidence。
- `source_ref`、`source_window_id`、`source_msg_range` 保留为证据，不要丢。

### `02_source_topics.json`

这是来源话题表，适合当作 conversation source index。

关键字段：

- `topic_id`
- `topic_label`
- `topic_role`
- `exposure_priority`
- `source_bundle_id`
- `chunk_id`
- `source_window_id`
- `source_window_title`
- `source_msg_range`
- `anchor_ids`
- `topic_keywords`
- `background_only`
- `excerpt_hint`
- `prev_topic_id`
- `next_topic_id`

推荐用途：

- 给 memory tree 生成 topic node。
- 给 warm memory 增加 `topic_ids` 和 `topic_labels`。
- 给 daily captures 建立可回溯 source index。
- 让主动浮现时知道哪些话题是 high priority，哪些只是 background。

### `03_persona_workspace_snapshot.json`

这是官方 app / Notion 端最有价值的“稳定人格工作台快照”。

它不应该每轮注入前台模型，但可以用于：

- 初始化一个空 Mossbridge 的 resident anchors。
- 给官方 app 端通过 Notion 工具读取“当前稳定印象”。
- 给 Codex 做月度导入和冲突比对。
- 给公开/迁移时做脱敏后的 starter memory。

## 每日网页端抓取插件的输入契约

浏览器插件或网页端抓取工具可以先输出 daily capture，不必直接写温记忆。

建议一日一个目录：

```text
cache/app_daily_captures/chatgpt_web/YYYY-MM-DD/
  manifest.json
  conversations.jsonl
  attachments.jsonl
```

`manifest.json` 建议字段：

```json
{
  "schema": "mossbridge_app_daily_capture_v0.1",
  "source_client": "chatgpt_web",
  "captured_date": "2026-05-01",
  "captured_at": "2026-05-01T23:50:00.000Z",
  "timezone": "Asia/Shanghai",
  "conversation_count": 0,
  "message_count": 0
}
```

`conversations.jsonl` 每行建议字段：

```json
{
  "source_client": "chatgpt_web",
  "conversation_id": "web-thread-id",
  "conversation_title": "title",
  "message_id": "msg-id",
  "role": "user",
  "text": "message text",
  "created_at": "2026-05-01T12:00:00.000Z",
  "local_date": "2026-05-01",
  "attachments": [],
  "source_url": ""
}
```

导入规则：

- daily capture 先进入 `cache/app_daily_captures/`。
- 归一化后再写入 `cache/conversation_cache/`。
- dreaming 从 conversation cache 提取 warm / ongoing / case / tree candidates。
- 人工或模型确认后的固有记忆再进入 `storage/notion_sync/` 和 Notion。

## Notion 同步权威

推荐权威关系：

```text
daily capture: source of raw recent context
conversation_cache: runtime sedimentation pool
warm_memory: local fast recall
memory_tree: local relation topology
case_index: local work provenance
Notion memory_entries: durable cross-app stable memory
Notion source_topics: durable source/topic index
```

Notion 不应该变成 raw transcript 仓，也不应该每轮都被 runtime 远程查询。

更稳的方式是：

```text
Notion stable memory
  -> periodic local import
  -> warm_memory / memory_tree / case_index
  -> runtime fast recall
  -> dreaming/export queue
  -> Notion stable memory
```

## 冲突处理

同一条稳定记忆必须有可追踪 id。

优先使用：

- `entry_id`
- `source_ref`
- `family_id`
- `topic_id`
- `event_anchor`

本地更新回写 Notion 时，必须保留：

- `last_synced_at`
- `notion_page_id`
- `local_material_id`
- `sync_status`: `imported` / `local_modified` / `notion_modified` / `conflict`
- `conflict_reason`

如果 Notion 和本地同时改了同一条，不要自动覆盖。写入：

```text
storage/notion_sync/conflicts/
```

让 Codex 或用户确认。

## 当前先不做的事

第一阶段先不做：

- 直接把网页端抓取插件写完。
- 直接把 Notion API 接成双向实时同步。
- 让 runtime 每轮远程查 Notion。
- 把 raw transcript 全量放进 Notion。

第一阶段只需要把仓位、字段、同步方向和导入契约确定下来。

## 最小验收

后续补代码时，用这四步验收：

1. Driftstone `01_memory_entries.json` 能导入为 warm memory / case index 候选。
2. Driftstone `02_source_topics.json` 能导入为 topic index / tree evidence。
3. 网页端 daily capture 能进入 `cache/app_daily_captures/` 并转入 `conversation_cache/`。
4. Notion stable memory 能被官方 app 读取，同时 Mossbridge 本地也能召回对应记忆。

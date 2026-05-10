# Codex Memory Setup For Mossbridge

这份文档是给“拿到 Mossbridge 的另一个 Codex”看的施工说明。

Mossbridge 不是某个私人本地系统的网关。它可以接入既有本地记忆仓，但不能默认依赖它。一个新部署应该先能拥有自己的轻量记忆仓：空仓可启动、日常可写入、测试可清理、未来可迁移。

注意：这里的 Codex 是“帮助用户施工的助手”。Mossbridge 自身仍然支持 `codex` 和 `claudecode` 两种 runtime；公开前的验收要覆盖两边，不能把 Codex 只当安装工。

## 给 Codex 的一句话任务

如果你在一台新机器上帮助用户部署 Mossbridge，可以先按这句话理解任务：

```text
请为 Mossbridge 准备一个独立的本地数据仓，把运行态、稳定记忆、测试数据和工作文件分开；优先只配置 MOSSBRIDGE_DATA_ROOT，不要接入任何私人旧仓路径，除非用户明确要求迁移或共享旧记忆。
```

## 推荐的本地目录

建议把代码、状态、记忆、办公 workspace 分开：

```text
~/Documents/Codex/Mossbridge/          # git 仓库，只放代码
~/Documents/MossbridgeState/           # 运行态：账号、session、日志、队列、表情包
~/Documents/MossbridgeData/            # 轻量记忆仓：温记忆、ongoing、树、case、cache
~/Documents/MossbridgeWorkspace/       # 前台 bot 可读写的办公区和附件区
```

不要把 `MossbridgeState`、`MossbridgeData`、`MossbridgeWorkspace` 放进 git。

## 最小 `.env`

从仓库里的 `.env.example` 复制一份：

```bash
cp .env.example .env
```

最少填这些：

```dotenv
MOSSBRIDGE_RUNTIME=codex
MOSSBRIDGE_WORKSPACE_ROOT=/Users/you/Documents/MossbridgeWorkspace
MOSSBRIDGE_ALLOWED_USER_IDS=your_wechat_user_id
MOSSBRIDGE_STATE_DIR=/Users/you/Documents/MossbridgeState
MOSSBRIDGE_DATA_ROOT=/Users/you/Documents/MossbridgeData
MOSSBRIDGE_IDENTITY_USER_ID=owner
MOSSBRIDGE_IDENTITY_REALM_ID=default
MOSSBRIDGE_IDENTITY_AGENT_ID=aji
```

如果用户选择 Claude Code runtime，再改成：

```dotenv
MOSSBRIDGE_RUNTIME=claudecode
MOSSBRIDGE_CLAUDE_MODEL=claude-opus-4-6
```

新部署不要先设置这些 override：

```dotenv
MOSSBRIDGE_ASHERIE_WARM_MEMORY_DIR=
MOSSBRIDGE_ASHERIE_TRUTH_LAYER_DIR=
MOSSBRIDGE_ASHERIE_MEMORY_TREE_DIR=
MOSSBRIDGE_ASHERIE_CASE_INDEX_DIR=
MOSSBRIDGE_ASHERIE_EPISODE_JOURNAL_DIR=
MOSSBRIDGE_ASHERIE_SOLITUDE_JOURNAL_DIR=
MOSSBRIDGE_ASHERIE_MEMORY_VERSION_BANK_DIR=
```

这些只适合迁移旧数据、共享旧记忆仓，或做高级调试。

## MossbridgeData 的文件夹层级

第一次启动时，代码会按 `MOSSBRIDGE_DATA_ROOT` 自动创建主要目录。预期形状如下：

```text
MossbridgeData/
  storage/
    warm_memory/
      owner/
        default/
          aji/
            materials/
              *.md
    ongoing_tracks.json
    ongoing_tracks.archive.jsonl
    calendar_items.json
    memory_versions/
    truth_layer/
    memory_tree/
    case_index/
    observation_journal/
    notion_sync/
    raw_transcript_archive/
    dreaming_mutation_log/
    relationship_contracts/
    curated_memories.json
  cache/
    app_daily_captures/
    conversation_cache/
    raw_transcript_active/
    wakeup_journal.json
    calendar_pending_actions.json
    hot/
      upstream_context_merge/
      context_basin/
      projections/
      snapshots/
    runtimes/
      codex/
    startup/
      shared_codex/
    transports/
      wechat/
        threads/
    hub/
```

这些目录的职责：

- `storage/warm_memory/`
  日常最重要的记忆卡。偏好、关系锚点、象征物、稳定印象都优先写这里。
- `storage/ongoing_tracks.json`
  近中期仍在发生的事，例如身体追踪、稿子、家族事件、购买决策、系统 bug。
- `storage/observation_journal/`
  可修正的观察日记。保存近期状态、生活节律、边界和相处默契，默认不是长期事实。
- `cache/conversation_cache/`
  最近对话沉淀池。它不是永久记忆，但会喂给 recall 和 dreaming。
- `storage/memory_tree/`
  Mossbridge 自己的轻量关系树预留位。第一阶段可以只放 node/edge/evidence JSON，不需要完整图数据库。
- `storage/truth_layer/`
  兼容旧冷树或更深层归档。新部署可以先空着。
- `storage/case_index/`
  记录“这个 agent 帮用户做过什么事”的工作索引。第一阶段可以先用 JSON/Markdown。
- `storage/notion_sync/`
  和 Notion 固有记忆同步的中间层。对齐 Driftstone 的 `memory_entries`、`source_topics`、`persona_workspace`。
- `cache/app_daily_captures/`
  官方 app / ChatGPT web 抓取插件的每日对话入口。它是原始沉淀素材，不是稳定记忆。
- `storage/dreaming_mutation_log/`
  记录 dreaming 做过哪些整理和改写，方便回滚和审计。
- `cache/`
  运行缓存，可以清理；不要把它当稳定记忆。

## 轻量记忆仓第一阶段怎么用

第一阶段不需要做完整记忆树。先保证四件事：

1. 温记忆能写入和召回。
2. ongoing 能保留近期事件连续性。
3. conversation cache 能沉淀最近多轮对话。
4. memory_tree 能保存少量明确关系边。

一条轻量树边可以长这样：

```json
{
  "edge_id": "edge-person-sister-branch-grandmother-home",
  "from_node_id": "person:sister",
  "to_node_id": "branch:grandmother-home",
  "relation_type": "belongs_to_family_branch",
  "confidence": "observed",
  "evidence_refs": ["warm:sister-current-context"],
  "notes": "Use this edge to expand sister-related recall into the grandmother-home branch when relevant.",
  "created_at": "2026-05-01T00:00:00.000Z",
  "updated_at": "2026-05-01T00:00:00.000Z"
}
```

重点不是把所有人生记忆塞进树里，而是让树保存“为什么这两张卡应该一起出现”。

## 稳定记忆、测试数据、工作文件要分开

推荐规则：

- 稳定记忆写入 `MossbridgeData/storage/`。
- 近期缓存写入 `MossbridgeData/cache/`。
- 微信账号、session、日志、表情包写入 `MossbridgeState/`。
- 微信图片、用户发来的文件、办公协作文档写入 `MossbridgeWorkspace/`。
- 测试记忆必须带 `test_run_id` 或放进单独 identity scope。

如果测试时污染了记忆仓，优先清理测试 scope，不要手动删除用户稳定记忆。

## 什么时候接旧仓或共享仓

只有在用户明确说“我要共享旧记忆”时，才配置这些路径：

```dotenv
# 如果另一个本地系统是中央大脑，优先直接让 Mossbridge 使用它的 data root。
MOSSBRIDGE_DATA_ROOT=/path/to/shared-memory-data

# 如果只迁移或共享部分仓位，再使用下面这些精确覆盖。
MOSSBRIDGE_ASHERIE_WARM_MEMORY_DIR=/path/to/existing/warm_memory
MOSSBRIDGE_ASHERIE_OBSERVATION_JOURNAL_DIR=/path/to/existing/observation_journal
MOSSBRIDGE_ASHERIE_EPISODE_JOURNAL_DIR=/path/to/existing/episode_journal
MOSSBRIDGE_ASHERIE_SOLITUDE_JOURNAL_DIR=/path/to/existing/solitude_journal
MOSSBRIDGE_ASHERIE_TRUTH_LAYER_DIR=/path/to/existing/truth_layer
MOSSBRIDGE_ASHERIE_MEMORY_VERSION_BANK_DIR=/path/to/existing/memory_versions
```

接旧仓前先确认写入权威：

- 如果另一个本地系统是中央记忆仓，Mossbridge 不要复制一份继续双写。
- 用户印象/观察簿也遵守同一规则：Bridge 应该写入共享的 `storage/observation_journal/`，而不是另起一套 Bridge 版用户印象。
- 旅行、小任务、照片分享这类有起止的事件簿也遵守同一规则：Bridge 应写入共享的 `storage/episode_journal/`，并保留可导出到 Obsidian 的 Markdown。
- 如果 Mossbridge 要独立分享，把旧卡导入为一次快照，并保留 `source_system`、`source_card_id`、`import_batch`。
- 不要让两个系统同时维护两份看似相同但会分叉的温记忆。

## 给前台模型的边界

记忆工具的作用是帮模型维护连续性，不是限制它怎么表达。

Codex 调试时要确认：

- 记忆管理代码不使用关键词强制规定前台语气。
- 模型可以主动要求新增记忆能力或指出当前系统不舒服。
- 主动唤醒不是裸提醒，应该带 warm/ongoing/recent context。
- 如果主动浮现不够用，模型应该继续搜索记忆，而不是用不合适的召回结果凑合回答。

## 验收清单

新部署至少要验证：

- `npm install` 成功。
- `.env` 指向空的 `MossbridgeState` 和 `MossbridgeData`。
- `npm run shared:start` 能以 Codex runtime 启动。
- `npm run shared:start:claudecode` 能以 Claude Code runtime 启动。
- `MossbridgeData/storage/warm_memory` 自动创建。
- `MossbridgeData/storage/memory_tree` 自动创建。
- `MossbridgeData/storage/case_index` 自动创建。
- 微信 `/bind` 后可以自然对话。
- 问“你能看看记忆里有什么吗”时，空仓不会报错。
- 写入一条温记忆后，后续对话能召回。
- 添加一个 ongoing track 后，主动唤醒能携带它。

如果这些都通过，Mossbridge 就拥有了自己的轻量记忆仓起点。后面再逐步补 dreaming、树边生成、case index 检索和公开版 rename。

独立发布口径：Bridge 不能假设某个私人外部 scheduler 一直开着。公开版要补 Bridge 自己的静默窗口 dreaming 入口；Codex / Claude Code 只负责执行同一份整理 prompt 和 JSON 契约，触发、日志、失败回执、写入目录都应归 Bridge 本体管理。

调试 dreaming 时，Codex 还要确认两件小事：第一，整理结果里的 `memory_metabolism`、warm write、cold promotion、cold patch 等字段能被日志或回执看见；第二，整理 prompt 不应该把前台模型的自然表达磨成冷淡工程口吻，也不应该写成关键词式行为限制。

## 官方 app 与 Notion 互通

如果用户希望 WeChat、Codex、官方 app 三边记忆互通，不要让官方 app 直接依赖 Mossbridge 本地文件。

推荐方式：

- 官方 app / ChatGPT web 的每日对话抓取进入 `cache/app_daily_captures/`。
- 归一化后进入 `cache/conversation_cache/`，参与 dreaming。
- 固有记忆通过 Notion 的 `memory_entries` / `source_topics` 同步。
- Mossbridge 周期性把 Notion 稳定记忆导入本地 `warm_memory`、`memory_tree`、`case_index`。
- 官方 app 通过 Notion 工具读取稳定记忆，不直接读 WeChat 状态目录。

更多见 [docs/notion-memory-interop.md](./notion-memory-interop.md)。

# Release Alignment Checklist

This file keeps discovered private-test issues aligned before Mossbridge is shared publicly. It should describe behavior and release risks, not private memories, logs, accounts, or local-only paths.

Last updated: 2026-05-13

## Current Alignment Map

| Area | Found issue | Public-release expectation |
| --- | --- | --- |
| Runtime ownership | Private testing can lean on an external scheduler or a Claude Code lane by accident. | Shared bridge code owns startup, wakeups, user-visible failure notices, and first-version memory delivery. Codex and Claude Code are adapters, not separate products. |
| Deferred nightly dreaming | Dreaming may run in a private external process, so standalone Bridge would not整理记忆 when that process is closed. | Deferred after the first public version. When reopened, Bridge must provide its own quiet-window entry and write to local `dreaming_mutation_log`, `warm_memory`, and `memory_tree` without a private external process. |
| Deferred dreaming completion gate | A scheduled dreaming item can be touched by the scheduler but still fail before mutation/writeback. | When dreaming is implemented, treat trigger as only an attempt. Mark complete only after mutation/writeback succeeds; foreground-active holds, runtime errors, parse failures, or write failures must reschedule the same item after a delay. |
| Deferred dreaming receipts | Executor results can be saved internally but disappear from wakeup/run logs. | When dreaming is implemented, `memory_metabolism`, warm writes, cold promotions, cold patches, batch promotions, and failures must be visible in logs or receipts. |
| Deferred dreaming tone | Memory整理 can drift into cold code-review or work-order language. | When dreaming is implemented, prompts may organize facts, but must preserve natural companionship texture and must not become frontend expression rules. |
| Failure visibility | Runtime failures, quota notices, send failures, and first-event timeouts can leave the user waiting. | Bridge notices should be visible, friendly, throttled, retry-aware, and excluded from memory ingestion. |
| Bridge notice voice | User-facing failure text can sound like the main bot reassuring the user instead of a system layer reporting status. | Runtime notices should be clearly prefixed as `[Mossbridge]`, concise, and operational enough that users can distinguish bridge status from the assistant's own reply. |
| Runtime model choice | Model selection was easy to document as Claude Code-only because private testing leaned that way. | `/model` should be a shared command: Codex uses a catalog when available, Claude Code accepts raw model ids, and overrides apply to the next turn. |
| Context delivery | Resident anchors, warm cards, cold vines, ongoing tracks, and recent-thread can become every-turn noise. | Delivery should be relevance-gated, session-aware, and able to退场 when a topic is no longer active. |
| Proactive wakeups | Wakeups can fire without enough recent memory, or fail at WeChat send. | Wakeups must carry warm/ongoing/recent context, defer/retry send failures, and avoid pretending a裸 reminder is relationship-aware. |
| Observation journal | Fresh observations can be recalled for unrelated queries. | Observation search must require semantic or route relevance; recency and confidence are boosters, not standalone matches. |
| Attachments and stickers | Images may arrive in bursts, stickers/CDN paths may fail, and overlong replies can be clipped by WeChat. | Batch nearby attachments before answering, preserve image notes in context, use fallbacks for sticker delivery, and route long-form output away from WeChat when configured. |
| Data separation | Private memory warehouses, state dirs, and test imports can bleed into a public clone. | Code, runtime state, stable memory, test data, attachments, and workspace files remain separable; clean-clone smoke must pass on an empty data root. |
| Default data root naming | Historical fallback names can make a fresh public clone look tied to a private memory lineage. | Explicit `MOSSBRIDGE_DATA_ROOT` remains recommended; if omitted, public code should use a Mossbridge-named data directory under state. |
| External imports | Rikkahub/GPT/Notion imports can pollute the live private memory warehouse. | Deferred after the first public version. When reopened, import tests must use an isolated data root, carry source metadata, dedupe before stable write, and remain deleteable/re-runnable. |
| Cold tree and cases | Cold layer can act like another text recall store instead of a relation network; case index is still skeletal. | Cold memory should express topology and evidence edges; case index should record work cases without becoming daily chat noise. |

## Sync Rule

When a private-test fix affects WeChat intake, memory routing, wakeups, dreaming, attachments, local supervision, or failure recovery, first land the idea in shared bridge docs/tests. Then decide whether active private Bridge, public Mossbridge, and any private external system need separate code changes.

Do not solve release issues by adding private keywords, personal paths, or one-off memory cheats. The goal is a bridge another person can clone and understand.

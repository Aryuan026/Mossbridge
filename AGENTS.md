# Mossbridge Agent Notes

Mossbridge is the public incubator line. Treat this repository as the code that a new user can clone, inspect with Codex, and deploy locally.

## Operating Boundary

- Do not modify, restart, take over, or bind any live private bridge service.
- The public service label is `com.mossbridge.bridge`.
- The default state directory is `~/.mossbridge`.
- Tests and smoke runs must use isolated paths:
  - `MOSSBRIDGE_STATE_DIR`
  - `MOSSBRIDGE_DATA_ROOT`
  - `MOSSBRIDGE_WORKSPACE_ROOT`
- Do not connect tests to a private memory warehouse or another bridge's account files.

## Runtime Model

Codex and Claude Code are both first-class runtimes.

Shared behavior belongs in bridge core:

- WeChat transport and command routing
- local state and data layout
- control-plane event ledger for heartbeat/runtime/memory/delivery decisions
- conversation cache and memory stores
- reminders, check-ins, deferred replies, cooldowns, and runtime notices
- attachment, sticker, file, and timeline workflows
- diagnostics and safe self-checks

Runtime adapters should only contain protocol-specific details:

- Codex RPC/session/MCP config handling
- Claude Code process/session/model/approval handling

Do not describe Mossbridge as Claude Code-only.

## What This Fork Adds

Compared with the upstream Cyberboss shape, Mossbridge adds two public incubator layers:

- Heartbeat system: random check-ins, due reminders, deferred replies, wakeup agenda, cooldowns, and safe self-checks are handled as runtime system turns. Random check-ins use a lightweight no-tool profile and can only reconnect or stay silent from injected context; due reminders, calendar wakeups, dreaming, case, and explicit maintenance turns can use the full tool profile when there is actual work to do. A heartbeat is not just a timer that always sends text.
- Memory delivery system: hot context, warm cards, resident anchors, notebook notes, ongoing tracks, observation journal, episode journal, conversation cache, case index, and cold-version compatibility are delivered as scoped context packets. These packets should ground continuity, not dictate one fixed front-stage voice.

Keep these layers runtime-neutral. Codex and Claude Code should receive the same bridge intent and memory contract, with only protocol/session/model differences kept in adapters.

For fresh deployments, `pinned` warm cards and `certainty_state: anchor` cards are resident anchors by default. Use `resident:false` only for important cards that should stay searchable but not sit in every turn.

For token hygiene, ordinary user turns may receive stable opening guidance once per runtime thread, but system wakeups must stay lean without waking empty. Heartbeat, reminder, and dreaming system turns should not re-send the full WeChat opening prompt; they should carry a short soul/identity wake anchor, the trigger, scoped memory packet, safe action envelope, and any small diagnostics needed for writeback. Bridge status reports remain `[Mossbridge]` notices, not front-stage assistant speech.

## Why The Main Settings Exist

- `MOSSBRIDGE_STATE_DIR`: local runtime state. It contains account/session/log/queue files and generated WeChat prompts. Never reuse a live private state dir for public smoke tests.
- `MOSSBRIDGE_DATA_ROOT`: local memory warehouse. It contains hot context, stable memory, notebook notes, active tracks, journals, cache, case index, cold-version compatibility, and mutation logs. New deployments should set this once and leave migration-only overrides unset.
- `MOSSBRIDGE_WORKSPACE_ROOT`: runtime file workspace. This is where attachments, notes, and project files can land; do not bind it to the user's whole home directory.
- `MOSSBRIDGE_IDENTITY_*`: memory scope. `user_id` identifies the human scope, `realm_id` separates deployments or relationships, and `agent_id` separates assistant/persona lineage. New public examples and defaults use `agent_id=moss`; older private warehouses may still contain historical agent ids, but fresh public code should not seed them.
- `MOSSBRIDGE_CHECKIN_*`: heartbeat cadence and guardrails. Token/context backoff and hot-chat windows exist to prevent proactive wakeups from interrupting active chat or overloading a near-full runtime context.
- `MOSSBRIDGE_ASHERIE_PRELUDE_*`: historical memory-layer env names for recall limits. Keep limits small unless a test proves larger packets improve continuity without bloating replies.
- `MOSSBRIDGE_MAINTENANCE_*`: public maintenance posture. The default is read-only report; self-repair must be an explicit private deployment choice.

Do not rename deep historical memory symbols casually. If you rename `src/asherie/*`, `MOSSBRIDGE_ASHERIE_*`, or legacy `agent_id` defaults, do it as a deliberate migration with tests and docs, not as a partial search/replace.

## Built-In Brain Boundary

Mossbridge's first public version is not an empty bridge that requires a separate private brain service. It carries its own local brain under `MOSSBRIDGE_DATA_ROOT`.

Treat the code areas this way:

- Mouth: `src/adapters/channel/weixin/` receives and sends WeChat messages.
- Engines: `src/adapters/runtime/codex/` and `src/adapters/runtime/claudecode/` translate runtime protocol details.
- Hands: `src/tools/` and non-memory `src/services/` expose files, reminders, stickers, timeline, and status work.
- Brain: `src/asherie/`, `src/services/asherie-memory-service.js`, `src/asherie/storage-layout.js`, and the boundary marker in `src/brain/README.md`.
- Control plane: `src/control/` records why the bridge queued, skipped, cooled down, retried, delivered, or completed an automatic action.

Mouth, engine, hand, and control-plane code should not write brain files directly. They should pass durable context through the memory service/domain boundary so storage paths, schemas, scope ids, and future migrations stay stable.

Control events are operational state under `MOSSBRIDGE_STATE_DIR`, not user memory. They may explain a skip, cooldown, heartbeat, or dreaming receipt, but they should not store raw prompts, private message bodies, credentials, context tokens, or hidden chain-of-thought.

Route memory-like material with this simple map:

- "小事记" and light diary notes: `storage/notebook/`.
- Unfinished active threads: `storage/ongoing_tracks.json`.
- Bounded events, trips, photo sessions, and small stories: `storage/episode_journal/`.
- Code work, deployment work, files, decisions, artifacts, and tests: `storage/case_index/`.
- Stable reusable continuity: `storage/warm_memory/`.
- Relationship/evidence topology candidates: `storage/memory_tree/`.
- Future ChatGPT or app captures: stage in `cache/app_daily_captures/`, `cache/conversation_cache/`, and `cache/hot/`; do not write raw captures straight into warm/cold/case memory.

## Public Tool Boundary

Mossbridge does not ship private external executors. Do not add tool names, prompts, docs, or tests that imply built-in access to private account/device/permission systems.

If a capability cannot work from Mossbridge's own public config, state/data root, and workspace root, keep it out of the public tool surface.

## Codex Setup Path

For a clean clone:

```bash
npm install
cp .env.example .env
npm run smoke:memory-empty
npm run smoke:memory-chain
npm run doctor
```

For isolated smoke tests, use disposable paths:

```bash
MOSSBRIDGE_RUNTIME=codex
MOSSBRIDGE_STATE_DIR=/tmp/mossbridge-smoke/state
MOSSBRIDGE_DATA_ROOT=/tmp/mossbridge-smoke/data
MOSSBRIDGE_WORKSPACE_ROOT=/tmp/mossbridge-smoke/workspace
```

Useful checks:

```bash
npm run smoke:memory-empty
npm run smoke:memory-chain
npm run check
node --test
npm run shared:status
npm run service:status:codex
```

Only run `npm run login`, `npm run shared:start`, service install/restart/takeover commands, or QR flows when the user explicitly asks for a local deployment or smoke run.

## Deferred Capture Import Boundary

Daily capture and Notion-style synchronization are deferred extension paths, not public first-version deployment requirements.

External ChatGPT web/app capture tools should export raw daily capture JSON. Mossbridge should ingest those captures as data, not as an external automation bridge.

The interchange contract is documented in:

- `docs/app-daily-capture-json.md`
- `schemas/app-daily-capture-bundle-v0.1.schema.json`

Validate an exported bundle without writing memory:

```bash
npm run capture:validate -- /path/to/capture-bundle.json
```

Daily captures belong under `MOSSBRIDGE_DATA_ROOT/cache/app_daily_captures/` after staging. They should not write directly to warm memory, cold memory, episode journals, or case indexes until a local importer/dreaming step accepts them.

## Same-Format Memory Portability

When validating existing Home/Mossbridge-shaped memory data, use the bundle
boundary instead of pointing a public smoke at a mother warehouse:

```bash
npm run memory:export -- --source-data-root /path/to/source-data --out /private/tmp/mossbridge-memory-bundle --replace-output
MOSSBRIDGE_STATE_DIR=/private/tmp/mossbridge-state MOSSBRIDGE_DATA_ROOT=/private/tmp/mossbridge-data npm run memory:import -- --bundle /private/tmp/mossbridge-memory-bundle
```

`memory:import` is dry-run by default. Only use `--apply --replace` with an
isolated target data root. The importer rewrites same-format identity fields and
scoped path names to the configured `MOSSBRIDGE_IDENTITY_*`, so this is the
preferred check for whether user identity is externalized enough for a new
WeChat deployment.

## Review Checklist

Before public-facing changes land:

- Keep runtime-neutral behavior in core.
- Keep Codex and Claude Code docs symmetric where both apply.
- Keep tests isolated from real state/data/workspace roots.
- Do not leave private names, private paths, screenshots, account IDs, or unavailable tool hints in source, docs, prompts, fixtures, or test names.
- Run the narrow tests for the changed area, then `npm run check` when touching source or scripts.

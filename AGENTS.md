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

- Heartbeat system: random check-ins, due reminders, deferred replies, wakeup agenda, cooldowns, and safe self-checks are handled as runtime system turns. A heartbeat is a chance for the model to inspect context and decide what useful action exists; it is not just a timer that always sends text.
- Memory delivery system: warm cards, resident anchors, ongoing tracks, observation journal, episode journal, conversation cache, and cold-version compatibility are delivered as scoped context packets. These packets should ground continuity, not dictate one fixed front-stage voice.

Keep these layers runtime-neutral. Codex and Claude Code should receive the same bridge intent and memory contract, with only protocol/session/model differences kept in adapters.

## Why The Main Settings Exist

- `MOSSBRIDGE_STATE_DIR`: local runtime state. It contains account/session/log/queue files and generated WeChat prompts. Never reuse a live private state dir for public smoke tests.
- `MOSSBRIDGE_DATA_ROOT`: local memory warehouse. It contains stable memory, active tracks, journals, cache, case index, cold-version compatibility, and mutation logs. New deployments should set this once and leave migration-only overrides unset.
- `MOSSBRIDGE_WORKSPACE_ROOT`: runtime file workspace. This is where attachments, notes, and project files can land; do not bind it to the user's whole home directory.
- `MOSSBRIDGE_IDENTITY_*`: memory scope. `user_id` identifies the human scope, `realm_id` separates deployments or relationships, and `agent_id` separates assistant/persona lineage. New public examples and defaults use `agent_id=moss`; older private warehouses may still contain historical agent ids, but fresh public code should not seed them.
- `MOSSBRIDGE_CHECKIN_*`: heartbeat cadence and guardrails. Token/context backoff and hot-chat windows exist to prevent proactive wakeups from interrupting active chat or overloading a near-full runtime context.
- `MOSSBRIDGE_ASHERIE_PRELUDE_*`: historical memory-layer env names for recall limits. Keep limits small unless a test proves larger packets improve continuity without bloating replies.
- `MOSSBRIDGE_MAINTENANCE_*`: public maintenance posture. The default is read-only report; self-repair must be an explicit private deployment choice.

Do not rename deep historical memory symbols casually. If you rename `src/asherie/*`, `MOSSBRIDGE_ASHERIE_*`, or legacy `agent_id` defaults, do it as a deliberate migration with tests and docs, not as a partial search/replace.

## Public Tool Boundary

Mossbridge does not ship private external executors. Do not add tool names, prompts, docs, or tests that imply built-in access to private account/device/permission systems.

If a capability cannot work from Mossbridge's own public config, state/data root, and workspace root, keep it out of the public tool surface.

## Codex Setup Path

For a clean clone:

```bash
npm install
cp .env.example .env
npm run smoke:memory-empty
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

## Review Checklist

Before public-facing changes land:

- Keep runtime-neutral behavior in core.
- Keep Codex and Claude Code docs symmetric where both apply.
- Keep tests isolated from real state/data/workspace roots.
- Do not leave private names, private paths, screenshots, account IDs, or unavailable tool hints in source, docs, prompts, fixtures, or test names.
- Run the narrow tests for the changed area, then `npm run check` when touching source or scripts.

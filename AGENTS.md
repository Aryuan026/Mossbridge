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

## Public Tool Boundary

Mossbridge does not ship private external executors. Do not add tool names, prompts, docs, or tests that imply built-in access to private account/device/permission systems.

If a capability cannot work from Mossbridge's own public config, state/data root, and workspace root, keep it out of the public tool surface.

## Codex Setup Path

For a clean clone:

```bash
npm install
cp .env.example .env
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
npm run check
node --test
npm run shared:status
npm run service:status:codex
```

Only run `npm run login`, `npm run shared:start`, service install/restart/takeover commands, or QR flows when the user explicitly asks for a local deployment or smoke run.

## Daily Capture Import Boundary

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

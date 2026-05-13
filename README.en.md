Acknowledgement: Mossbridge is derived from [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss); the WeChat bridge idea, runtime shell, and AGPL lineage come from that project.

# Mossbridge

Mossbridge, or 苔藓小桥, is a local-first WeChat bridge for Codex and Claude Code.

It keeps the useful bridge shape from Cyberboss: one WeChat account, one local runtime, one shared thread, and one local set of tools for sending messages, receiving files, scheduling wakeups, and writing memory. On top of that shell, this fork is moving toward a built-in memory-centered companion architecture with hot context, notebook notes, warm memory, ongoing tracks, case memory, recent context cache, optional cold-memory providers, proactive wakeups with context, and strict separation between code, private data, and test data.

This repository is not the upstream Cyberboss project and is not an official Cyberboss release.

## Runtime Posture

Codex and Claude Code are both first-class runtimes.

Shared behavior belongs in bridge core:

- WeChat login, polling, chunking, attachment intake, and delivery
- workspace binding and shared thread state
- reminders, check-ins, and system wakeups
- built-in brain layout, memory context packets, and writeback
- user-visible runtime failure notices

Runtime adapters should only hold protocol-specific details, such as Codex RPC/session handling or Claude Code process/session/model handling.

## Public Names

- package and CLI: `mossbridge`
- environment prefix: `MOSSBRIDGE_*`
- default state directory: `${HOME}/.mossbridge`
- default launchd label: `com.mossbridge.bridge`
- MCP server/tool namespace: `mossbridge_tools` / `mossbridge_*`

Some memory internals still carry historical Asherie terms. Treat those as cleanup debt unless they appear in upstream acknowledgement, migration notes, or memory-domain vocabulary.

## Why The Extra Settings Exist

Mossbridge separates transport state, memory data, and runtime workspace on purpose:

- `MOSSBRIDGE_STATE_DIR` stores QR login, accounts, sessions, logs, queues, cooldowns, and generated WeChat prompt files. The default is `${HOME}/.mossbridge`.
- `MOSSBRIDGE_DATA_ROOT` stores hot context, notebook notes, warm memory, ongoing tracks, journals, conversation cache, case index, app captures, and mutation logs. Fresh installs should start with one clean data root.
- `MOSSBRIDGE_WORKSPACE_ROOT` is the file workspace exposed to the runtime. It should not be the user's whole home directory.
- `MOSSBRIDGE_CHECKIN_*` settings control heartbeat opportunities with hot-window and context-backoff guardrails.
- `MOSSBRIDGE_ASHERIE_PRELUDE_*` settings are historical memory-layer names for turn-level memory delivery limits.
- `MOSSBRIDGE_MAINTENANCE_*` keeps public heartbeat self-checks read-only unless a private operator explicitly enables repair.

## Requirements

- Node.js `>= 22`
- A local `codex` or `claude` command
- A WeChat account that can complete the QR login flow
- Chrome / Chromium / Edge only if screenshot features are needed

## Install

```bash
git clone https://github.com/Aryuan026/Mossbridge.git
cd Mossbridge
npm install
```

See [docs/quickstart.md](./docs/quickstart.md) for the full clean-clone path.

## Minimal Configuration

Create `.env` from `.env.example`:

```dotenv
MOSSBRIDGE_RUNTIME=codex
MOSSBRIDGE_WORKSPACE_ROOT=/absolute/path/to/your/workspace
MOSSBRIDGE_STATE_DIR=/absolute/path/to/mossbridge-state
MOSSBRIDGE_DATA_ROOT=/absolute/path/to/mossbridge-data
MOSSBRIDGE_ALLOWED_USER_IDS=
```

For Claude Code:

```dotenv
MOSSBRIDGE_RUNTIME=claudecode
MOSSBRIDGE_CLAUDE_MODEL=claude-opus-4-6
```

For a fresh deployment, set only `MOSSBRIDGE_DATA_ROOT` for memory. More specific memory paths are migration-only overrides.

## Daily Commands

Codex runtime:

```bash
npm run login
npm run shared:start
npm run shared:open
npm run shared:status
```

Claude Code runtime:

```bash
npm run login
npm run shared:start:claudecode
npm run shared:open:claudecode
npm run shared:status:claudecode
```

Useful WeChat commands:

- `/bind /absolute/path`
- `/status`
- `/new`
- `/reread`
- `/compact`
- `/stop`
- `/switch <threadId>`
- `/checkin <min>-<max>`
- `/chunk <number>`
- `/model`
- `/model <id>`
- `/model default`
- `/model refresh`
- `/help`

## Data Boundaries

- Runtime state belongs in `${HOME}/.mossbridge` or `MOSSBRIDGE_STATE_DIR`.
- Personal memory belongs in `MOSSBRIDGE_DATA_ROOT` or explicitly configured memory paths.
- Test data should use disposable state/data/workspace roots.
- Public releases must not include WeChat tokens, account ids, context tokens, logs, QR data, private memory, private screenshots, or personal workspace bindings.
- Channel, runtime, and tool code should not write brain files directly. Memory writes should go through the memory service boundary.

## Docs

- [docs/quickstart.md](./docs/quickstart.md)
- [docs/commands.md](./docs/commands.md)
- [docs/architecture-for-humans.md](./docs/architecture-for-humans.md)
- [docs/brain-layer-boundary.md](./docs/brain-layer-boundary.md)
- [docs/runtime-neutral-readiness.md](./docs/runtime-neutral-readiness.md)
- [docs/memory-storage.md](./docs/memory-storage.md)
- [docs/public-release-readiness.md](./docs/public-release-readiness.md)

## License

This project keeps the upstream AGPL lineage and is released under `AGPL-3.0-only`.

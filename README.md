Acknowledgement: Mossbridge is derived from [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss); the WeChat bridge idea, runtime shell, and AGPL lineage come from that project.

# Mossbridge

Mossbridge, or 苔藓小桥, is a local-first WeChat bridge for Codex and Claude Code.

It keeps the practical mouth of Cyberboss: one WeChat account, one local runtime, one way for the model to send messages, receive files, wake itself later, and stay attached to a shared thread. On top of that shell, this fork is moving toward a built-in memory-centered companion architecture: hot context, warm memory, notebook notes, ongoing tracks, case memory, optional cold-tree providers, proactive wakeups with context, and careful separation between code, personal data, and test data.

This repository is not the upstream Cyberboss project and is not an official Cyberboss release.

## What Is Different From Cyberboss?

- **Memory-first design**
  Mossbridge adds a built-in brain layer around hot context, warm cards, notebook notes, ongoing tracks, context packets, cold-version compatibility, and recent conversation cache. The front-stage model can read, write, update, and correct memory through project tools instead of relying only on the current chat window.

- **Companion continuity instead of fixed persona control**
  The bridge avoids keyword-style behavior cages in the memory-management layer. Prompts should help the model understand context and maintain continuity, not force one rigid speaking style.

- **Proactive wakeups with memory context**
  Random check-ins and scheduled reminders are treated as model wakeups, not just alarm messages. Wakeups can carry recent context and relevant warm/ongoing memory so they do not feel detached from the relationship history.

- **Local memory warehouse posture**
  The first public version keeps the core loop local: WeChat, the selected runtime, and Mossbridge's own memory stores. Future ChatGPT web/app captures or other windows can be added later as data sources, but they are not part of the first deploy path and should stage through hot/recent context before becoming stable memory.

- **Ongoing-track layer**
  Near-term living threads, such as health tracking, writing tasks, family updates, purchases, and unresolved cases, can stay suspended near the front of memory without being prematurely frozen into permanent cold memory.

- **Optional cold-tree compatibility**
  Mossbridge can read or patch cold-memory structures through configured providers, but the current recommendation is not to make the WeChat bridge depend on a personal external cold tree for daily continuity.

- **Sticker and attachment workflow**
  Incoming WeChat images and attachments can be saved into an inbox, summarized for context, and, when suitable, registered into a local sticker catalog. The model gets sticker tools instead of needing brittle text substitutions like `[微笑]`.

- **WeChat reply handling**
  The bridge includes chunking and normalization work so long replies, paragraph breathing, short-message merging, and WeChat emoji shortcodes behave more naturally.

- **Runtime flexibility**
  Codex and Claude Code are both supported. Shared mode is the preferred daily workflow, with commands for opening the same thread from terminal and WeChat and for selecting the next-turn model when supported by the local runtime.

- **Safe self-check by default**
  Heartbeat maintenance can inspect bridge health, queues, cooldowns, and context pressure, but public Mossbridge defaults to reporting instead of silently restarting services, rebinding accounts, editing files, deleting memory, or changing credentials. See [docs/safe-self-check.md](./docs/safe-self-check.md).

## Why The Extra Settings Exist

Mossbridge carries more configuration than the original bridge because it is trying to keep three things separate: the transport account, the assistant's memory warehouse, and the user's working files.

- `MOSSBRIDGE_STATE_DIR` is runtime state: QR login, account files, sessions, logs, queues, cooldowns, and generated WeChat prompt files. It defaults to `${HOME}/.mossbridge`.
- `MOSSBRIDGE_DATA_ROOT` is memory data: hot context, warm cards, notebook notes, ongoing tracks, observation and episode journals, conversation cache, case index, cold-version compatibility, and mutation logs. Fresh deployments should start with one clean data root.
- `MOSSBRIDGE_WORKSPACE_ROOT` is the working area exposed to the runtime for files, attachments, and project work. It should not be the user's whole home directory.
- `MOSSBRIDGE_CHECKIN_*` settings control heartbeat opportunities. They are not simple alarm frequency knobs: hot-window and token-backoff settings keep proactive wakeups from interrupting an active chat or overloading a near-full runtime context.
- `MOSSBRIDGE_ASHERIE_PRELUDE_*` settings are historical memory-layer names for how much context gets delivered into a turn. Keep these limits modest so memory helps the model land the current reply instead of flooding it.
- `MOSSBRIDGE_MAINTENANCE_*` settings keep the public heartbeat posture read-only by default. Private operators can opt into repair, but public clone smoke tests should only inspect and report.

## Public Naming And Runtime Posture

The public surface is now Mossbridge:

- package and CLI: `mossbridge`
- environment prefix: `MOSSBRIDGE_*`
- default state directory: `${HOME}/.mossbridge`
- launchd label: `com.mossbridge.bridge`
- MCP server/tool namespace: `mossbridge_tools` / `mossbridge_*`

Codex and Claude Code are both first-class runtimes. Shared bridge behavior belongs in bridge core; runtime adapters should only carry protocol-specific details such as Codex RPC/session handling or Claude Code process/session/model handling.

Some memory internals still use historical Asherie terms. Treat those as cleanup debt unless they are part of the explicit upstream acknowledgement, migration notes, or memory-domain vocabulary.

## Requirements

- Node.js `>= 22`
- A local `codex` or `claude` command
- A WeChat bridge account that can be logged in with the local QR flow
- Chrome / Chromium / Edge only if screenshot features are needed

## Install

```bash
git clone https://github.com/Aryuan026/Mossbridge.git
cd Mossbridge
npm install
```

For the full first-run path, including QR login and `/bind`, see [docs/quickstart.md](./docs/quickstart.md).

If you ask Codex to help deploy a fresh clone, have it read [AGENTS.md](./AGENTS.md) first, then [docs/codex-memory-setup.md](./docs/codex-memory-setup.md). Those two files explain the public service boundary, isolated state/data/workspace paths, and the empty memory smoke.

## Minimal Configuration

Create a local `.env` in the project directory. Private `.env` files and runtime state are intentionally ignored by git.

```dotenv
MOSSBRIDGE_RUNTIME=codex
MOSSBRIDGE_WORKSPACE_ROOT=/absolute/path/to/your/workspace
MOSSBRIDGE_STATE_DIR=/absolute/path/to/mossbridge-state
MOSSBRIDGE_DATA_ROOT=/absolute/path/to/mossbridge-data
MOSSBRIDGE_ALLOWED_USER_IDS=
```

For Claude Code, set:

```dotenv
MOSSBRIDGE_RUNTIME=claudecode
MOSSBRIDGE_CLAUDE_MODEL=claude-opus-4-6
```

Optional memory/data migration settings:

```dotenv
MOSSBRIDGE_ASHERIE_WARM_MEMORY_DIR=/absolute/path/to/warm_memory
MOSSBRIDGE_ASHERIE_TRUTH_LAYER_DIR=/absolute/path/to/truth_layer
MOSSBRIDGE_ASHERIE_MEMORY_VERSION_BANK_DIR=/absolute/path/to/memory_versions
```

For new deployments, prefer setting only `MOSSBRIDGE_DATA_ROOT` first. The more specific paths are for intentional migration or sharing with an existing memory warehouse.

## Daily Commands

```bash
npm run smoke:memory-empty
npm run login
npm run shared:start
npm run shared:open
npm run shared:status
```

Claude Code equivalents:

```bash
npm run shared:start:claudecode
npm run shared:open:claudecode
npm run shared:status:claudecode
```

Useful WeChat commands:

- `/bind /absolute/path`
  Bind the current chat to a workspace.
- `/status`
  Show workspace, thread, model, and context status.
- `/model`
  Show selected, default, effective, and catalog-backed models for the current runtime.
- `/model <id>`
  Select a model for the next turn. Codex uses its model catalog when available; Claude Code accepts raw model ids.
- `/model default`
  Clear the workspace override and use the runtime default on the next turn.
- `/model refresh`
  Ask the runtime adapter to refresh its model catalog when supported.
- `/reread`
  Reload local instructions and operations templates into the current thread.
- `/checkin <min>-<max>`
  Update the random proactive wakeup interval.
- `/chunk <number>`
  Adjust minimum merge size for short WeChat reply chunks.

## Data Boundaries

Mossbridge is designed so code and personal data can be separated. The bridge ships with its own brain layer, but that layer must remain separate from the mouth and hands that move messages and files.

- Git should contain source code, templates, tests, and docs.
- Runtime account data should stay in `${HOME}/.mossbridge` or another ignored state directory.
- Personal memory data should stay under `MOSSBRIDGE_DATA_ROOT` or explicitly configured memory paths.
- Test data should be removable without touching stable personal memory.
- A future public release should not include private memory cards, account tokens, local logs, QR data, or personal workspace bindings.
- Channel/runtime/tool changes should not write brain files directly. Memory writes should go through the memory service boundary and preserve the documented data layout.

## Memory Layers

The current memory model is:

- **warm memory**
  Daily relationship continuity, preferences, symbolic objects, stable impressions, and reusable context cards.
- **hot memory**
  Short-lived cross-window context basin, projections, and snapshots for future ChatGPT capture merges and active conversation handoff.
- **notebook**
  Human-readable small notes and diary-like "小事记". These are source material for memory work, not automatically stable facts.
- **ongoing tracks**
  Active medium-term threads that need continuity but are not necessarily permanent facts.
- **conversation cache**
  Recent cross-window traces and tail snippets that can feed dreaming or context packets.
- **cold/version layer**
  Deeper archive, compatibility with older memory packages, and future relationship/time topology.
- **case index**
  A developing layer for "what the agent helped with", especially file work and project work.

See [docs/memory-storage.md](./docs/memory-storage.md) for the storage plan.

## Agent Tools

The model-facing capabilities are exposed as local project tools. Current tool families include:

- reminders and system wakeups
- notebook/diary and timeline operations
- file delivery
- sticker catalog operations
- memory context packets
- warm-memory write/search/read/update/delete
- ongoing-track upsert/read/list/close
- cold-memory read/search/patch/version operations

The model-facing namespace is `mossbridge_tools`, with tools named `mossbridge_*`.

## Public-Release Cleanup Checklist

Before making this repository public, do a final naming and privacy pass:

- keep historical `ASHERIEBRIDGE_*` and Cyberboss names out of runtime entrypoints; mention them only in migration or upstream-lineage notes
- decide whether any old state directory aliases should be supported or explicitly rejected
- scan source, tests, docs, templates, screenshots, and fixtures for personal paths or private names
- remove or replace private screenshots and memory examples
- verify that the bridge can run with an empty data warehouse
- document what is bundled and what must be provided by the user's own memory store

## Docs

- [docs/commands.md](./docs/commands.md)
- [docs/quickstart.md](./docs/quickstart.md)
- [docs/architecture-for-humans.md](./docs/architecture-for-humans.md)
- [docs/brain-layer-boundary.md](./docs/brain-layer-boundary.md)
- [docs/memory-storage.md](./docs/memory-storage.md)
- [docs/codex-memory-setup.md](./docs/codex-memory-setup.md)
- [docs/runtime-neutral-readiness.md](./docs/runtime-neutral-readiness.md)
- [docs/gateway-shaped-architecture.md](./docs/gateway-shaped-architecture.md)
- [docs/public-release-readiness.md](./docs/public-release-readiness.md)

Deferred extension notes:

- [docs/app-daily-capture-json.md](./docs/app-daily-capture-json.md)
- [docs/notion-memory-interop.md](./docs/notion-memory-interop.md)

Some docs still preserve Cyberboss wording where they describe upstream lineage or older architecture notes. Public setup docs should otherwise use Mossbridge names.

## License

This project keeps the upstream AGPL lineage and is released under `AGPL-3.0-only`.

If you modify it, extend it, or offer it to users over a network, you must provide the corresponding source code under the AGPL terms.

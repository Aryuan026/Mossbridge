Acknowledgement: Mossbridge is derived from [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss); the WeChat bridge idea, runtime shell, and AGPL lineage come from that project.

# Mossbridge

Mossbridge, or 苔藓小桥, is a local-first WeChat bridge for Codex and Claude Code.

It keeps the practical mouth of Cyberboss: one WeChat account, one local runtime, one way for the model to send messages, receive files, wake itself later, and stay attached to a shared thread. On top of that shell, this fork is moving toward a built-in memory-centered companion architecture: hot context, warm memory, notebook notes, ongoing tracks, case memory, optional cold-tree providers, proactive wakeups with context, and careful separation between code, personal data, and test data.

This repository is not the upstream Cyberboss project and is not an official Cyberboss release.

## Architecture At A Glance

Mossbridge is intentionally split into five parts:

```text
WeChat mouth
  -> bridge core and tools
  -> Codex / Claude Code runtime engine
  -> built-in local brain
  -> control plane ledger
```

- **Mouth**: WeChat login, inbound messages, reply delivery, files, stickers, and bridge notices.
- **Hands**: project tools for reminders, notebook, files, timeline, stickers, memory, and safe status checks.
- **Engines**: Codex and Claude Code adapters. They own protocol/session/model details only.
- **Brain**: local memory under `MOSSBRIDGE_DATA_ROOT`: hot context, warm cards, notebook, ongoing tracks, observation, episode, case, and compatibility cold layers.
- **Control plane**: local operational ledger under `MOSSBRIDGE_STATE_DIR/control-events.jsonl`, recording why Mossbridge queued, skipped, cooled down, delivered, retried, or completed an automatic action.

The control plane is the guardrail against "just adding another fallback". It keeps runtime, heartbeat, memory delivery, and dreaming behavior explainable without turning bridge status into the main assistant's voice.

## What Is Different From Cyberboss?

- **Memory-first design**
  Mossbridge adds a built-in brain layer around hot context, warm cards, notebook notes, ongoing tracks, context packets, cold-version compatibility, and recent conversation cache. The front-stage model can read, write, update, and correct memory through project tools instead of relying only on the current chat window.

- **Companion continuity instead of fixed persona control**
  The bridge avoids keyword-style behavior cages in the memory-management layer. Prompts should help the model understand context and maintain continuity, not force one rigid speaking style.

- **Proactive wakeups with memory context**
  Random check-ins and scheduled reminders are treated as model wakeups, not just alarm messages. Wakeups can carry recent context and relevant warm/ongoing memory so they do not feel detached from the relationship history.

- **Local memory warehouse posture**
  The first public version keeps the core loop local: WeChat, the selected runtime, and Mossbridge's own memory stores. Web AI captures from ChatGPT, Claude, Gemini, Perplexity, Rikkahub, or other browser windows can be staged into cache and hot context, but they do not become stable memory until local brain/dreaming passes promote them.

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
  Random check-ins use a lightweight no-tool profile so they can reconnect or stay silent without loading the full MCP tool surface. Calendar, reminder, dreaming, and explicit maintenance wakeups can inspect bridge health, queues, cooldowns, and context pressure, but public Mossbridge defaults to reporting instead of silently restarting services, rebinding accounts, editing files, deleting memory, or changing credentials. See [docs/safe-self-check.md](./docs/safe-self-check.md).

- **Cybernetic control plane**
  Mossbridge records operational decisions in a local control ledger: why a heartbeat was queued or skipped, why a runtime cooled down, what memory packet was delivered, and whether a dreaming/metabolism pass completed. This keeps the bridge explainable without turning bridge status into the main assistant's voice.

## Why The Extra Settings Exist

Mossbridge carries more configuration than the original bridge because it is trying to keep three things separate: the transport account, the assistant's memory warehouse, and the user's working files.

- `MOSSBRIDGE_STATE_DIR` is runtime state: QR login, account files, sessions, logs, queues, cooldowns, and generated WeChat prompt files. It defaults to `${HOME}/.mossbridge`.
- `MOSSBRIDGE_STATE_DIR/control-events.jsonl` is the control ledger: bridge/runtime/memory delivery decisions for debugging and pressure-test review. It is operational state, not durable user memory.
- `MOSSBRIDGE_DATA_ROOT` is memory data: hot context, warm cards, notebook notes, ongoing tracks, observation and episode journals, conversation cache, case index, cold-version compatibility, and mutation logs. Fresh deployments should start with one clean data root.
- `storage/raw_transcript_archive` under the data root is the small old-file fallback for warm-triggered dialogue evidence. It is only opened when cold-root recall is explicitly attempted and misses, with `MOSSBRIDGE_ASHERIE_PRELUDE_LOCAL_ARCHIVE_LIMIT` keeping the delivered evidence short.
- `MOSSBRIDGE_WORKSPACE_ROOT` is the working area exposed to the runtime for files, attachments, and project work. It should not be the user's whole home directory.
- `MOSSBRIDGE_CHECKIN_*` settings control heartbeat opportunities. They are not simple alarm frequency knobs: hot-window and token-backoff settings keep proactive wakeups from interrupting an active chat or overloading a near-full runtime context. Random check-ins keep a lightweight no-tool runtime profile; due reminders, calendar wakeups, dreaming, and explicit maintenance turns can still use the full tool profile when there is actual work to do.
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

If you ask Codex to help deploy a fresh clone, have it read these in order:

1. [AGENTS.md](./AGENTS.md)
2. [docs/codex-memory-setup.md](./docs/codex-memory-setup.md)
3. [docs/quickstart.md](./docs/quickstart.md)

Those files explain the public service boundary, isolated state/data/workspace paths, the built-in brain, the control ledger, and the empty-memory smoke. Codex should not reuse a private state directory, connect an old personal memory warehouse, or restart/take over another bridge service while doing a public smoke.

## Minimal Configuration

Create a local `.env` in the project directory. Private `.env` files and runtime state are intentionally ignored by git.

```dotenv
MOSSBRIDGE_RUNTIME=codex
MOSSBRIDGE_WORKSPACE_ROOT=/absolute/path/to/your/workspace
MOSSBRIDGE_STATE_DIR=/absolute/path/to/mossbridge-state
MOSSBRIDGE_DATA_ROOT=/absolute/path/to/mossbridge-data
MOSSBRIDGE_ALLOWED_USER_IDS=
```

Optional Codex runtime controls:

```dotenv
MOSSBRIDGE_CODEX_MODEL=
MOSSBRIDGE_CODEX_MODEL_PROVIDER=
MOSSBRIDGE_CODEX_NATIVE_IMAGE_INPUT=
MOSSBRIDGE_CODEX_COMMAND=
MOSSBRIDGE_CODEX_MODEL_CHOICES=cloud=gpt-5.4,local=gemma4:26b-32k@ollama
```

Use these when you need to pin a Codex model, point Codex at a local provider, or override whether the current Codex model supports native image input. For local providers such as Ollama, copy [templates/codex-local-provider.sh](./templates/codex-local-provider.sh) outside the repo, make it executable, and set `MOSSBRIDGE_CODEX_COMMAND` to that copied script.

`MOSSBRIDGE_CODEX_MODEL_CHOICES` is the human-friendly `/model` menu. Entries use `alias=model` or `alias=model@provider`, so `/model local` can expand to `gemma4:26b-32k` plus provider `ollama` without the user memorizing exact local model names.

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

Web AI capture bundles can be checked and imported into cache/hot memory without promoting them to stable memory:

```bash
npm run capture:validate -- /path/to/capture-bundle.json
npm run capture:import -- /path/to/capture-bundle.json
```

Same-format Mossbridge/Home-shaped memory data can be copied through a portable bundle for isolated WeChat validation:

```bash
npm run memory:export -- --source-data-root /path/to/source-data --out /private/tmp/mossbridge-memory-bundle --replace-output
MOSSBRIDGE_STATE_DIR=/private/tmp/mossbridge-state MOSSBRIDGE_DATA_ROOT=/private/tmp/mossbridge-data npm run memory:import -- --bundle /private/tmp/mossbridge-memory-bundle
```

Import is dry-run by default. Add `--apply --replace` only when the target data root is isolated and disposable.

Useful WeChat commands:

- `/bind /absolute/path`
  Bind the current chat to a workspace.
- `/status`
  Show workspace, thread, model, and context status.
- `/model`
  Show selected, default, effective, and catalog-backed models for the current runtime.
- `/model <id>`
  Select a model for the next turn. If model choices are configured, aliases such as `/model local` are accepted.
- `/model --provider <id> <model>`
  For Codex, select a model and store a provider such as `ollama` for this WeChat binding.
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

Proactive check-ins also have a daily safety budget. The budget uses weighted tokens: fresh/cache-write/output tokens count fully, cache-read tokens count lightly by default. This keeps cache-heavy quiet patrols from freezing the whole day while still preventing background wakeups from burning through runtime quota.

## Data Boundaries

Mossbridge is designed so code and personal data can be separated. The bridge ships with its own brain layer, but that layer must remain separate from the mouth and hands that move messages and files.

- Git should contain source code, templates, tests, and docs.
- Runtime account data should stay in `${HOME}/.mossbridge` or another ignored state directory.
- Personal memory data should stay under `MOSSBRIDGE_DATA_ROOT` or explicitly configured memory paths.
- Test data should be removable without touching stable personal memory.
- A future public release should not include private memory cards, account tokens, local logs, QR data, or personal workspace bindings.
- Channel/runtime/tool changes should not write brain files directly. Memory writes should go through the memory service boundary and preserve the documented data layout.
- Control-plane events stay in state. They can mention counts, reasons, and ids, but should not become warm/cold memory unless a later explicit memory tool turns a human-meaningful lesson into a normal memory object.

## Memory Layers

The current memory model is:

- **warm memory**
  Daily relationship continuity, preferences, symbolic objects, stable impressions, and reusable context cards.
- **hot memory**
  Short-lived cross-window context basin, upstream packages, projections, and snapshots for web AI capture merges and active conversation handoff.
- **notebook**
  Human-readable small notes and diary-like "小事记". These are source material for memory work, not automatically stable facts.
- **ongoing tracks**
  Active medium-term threads that need continuity but are not necessarily permanent facts.
- **conversation cache**
  Recent cross-window traces and tail snippets that can feed dreaming or context packets.
- **dreaming/metabolism log**
  Quiet-window attempts, mutation/no-op receipts, retry metadata, and completion records for bridge-owned memory整理.
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
- memory-metabolism/dreaming receipts
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
- [docs/control-plane.md](./docs/control-plane.md)
- [docs/brain-layer-boundary.md](./docs/brain-layer-boundary.md)
- [docs/memory-storage.md](./docs/memory-storage.md)
- [docs/memory-portability.md](./docs/memory-portability.md)
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

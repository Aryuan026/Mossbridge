# AI Deployment Guide

This guide is for an AI assistant helping a user deploy Mossbridge from a clean clone. Treat the repository and package scripts as the source of truth. Do not copy old private deployment habits into a public install.

Mossbridge supports both Codex and Claude Code as runtimes. In this document, "AI deployment helper" means the assistant doing setup work; "runtime" means the local `codex` or `claude` command that will answer WeChat turns.

## Agent-Driven Runtime Notes

Mossbridge is usually deployed by an AI assistant for a human operator, and the running WeChat bridge is also driven by a background runtime agent. Do not treat every setting as a human-facing product preference. Many settings exist to keep an agent-driven bridge safe, portable, and runtime-neutral.

Use this split when deciding where a change belongs:

- Shared bridge/core settings apply to both Codex and Claude Code: WeChat intake, allowlist, state/data/workspace roots, memory delivery, check-in, dreaming, reminders, runtime notices, approvals, session-refresh queueing, and service guard behavior.
- Codex-only settings belong behind `MOSSBRIDGE_CODEX_*`: Codex command path, model/provider selection, model catalog behavior, local provider wrapper, native image input, and Codex RPC/session details.
- Claude Code-only settings belong behind `MOSSBRIDGE_CLAUDE_*` or the `:claudecode` scripts: Claude model override, process/session behavior, and Claude-specific approval/session recovery.
- Pressure-test-derived behavior should be treated as a hypothesis for the next runtime until it is verified on that runtime. Claude Code pressure-test fixes can inform Codex CLI setup, but they do not prove Codex CLI stability by themselves.

Important deployment interpretation:

- Public Mossbridge should not be made Claude Code-only or Codex-only.
- Shared runtime behavior should be fixed in bridge core when possible, not duplicated in both adapters.
- Adapter-specific behavior should be limited to protocol, process/RPC, model, image input, approval, and session-id differences.
- Do not enlarge every memory packet or add foreground instructions to compensate for weak recall. Use diagnostics and relevance gates first.
- Do not treat token percentage alone as a mandatory session switch. Compression keeps a session alive; switching sessions is for recovering from pollution, stale state, tool errors, or handoff-worthy work boundaries.

For the current Codex CLI pressure-test transition, read `docs/codex-cli-pressure-test-handoff.md` before changing deployment defaults.

## Hard Boundary

Do not touch live state or accounts unless the user explicitly asks for that exact local deployment action.

- Do not reuse another bridge's `MOSSBRIDGE_STATE_DIR`.
- Do not reuse or mount a live shared `MOSSBRIDGE_DATA_ROOT`.
- Do not run QR login, `shared:start`, service install, service restart, or service takeover without explicit user instruction.
- Do not import old memory directly into a new live data root.
- Do not write relationship/persona/resident seed memory before the user has had a first conversation and confirmed the content.
- Do not guess the user's name, gender, diagnosis, relationship, preferences, private facts, or identity from templates.

An empty data root is valid. Mossbridge must be able to start, build an empty memory packet, and reply before any history import or resident anchor exists.

## 1. Preflight

Confirm the local facts first:

```bash
node -v
npm -v
command -v codex || true
command -v claude || true
uname -a
```

Requirements:

- Node.js `>= 22`
- At least one runtime command: `codex` or `claude`
- A platform note. The launchd/service scripts are macOS-only.
- A planned isolated state dir, data root, and workspace root.
- A free local port if using Codex shared app-server mode. The default is `8765`.

Recommended isolated paths for smoke:

```text
/tmp/mossbridge-smoke/state
/tmp/mossbridge-smoke/data
/tmp/mossbridge-smoke/workspace
```

These `/tmp` paths are disposable smoke paths only. Before QR login for real use, and before any service install/takeover, require the user to choose persistent state/data/workspace paths.

## 2. Install Dependencies

Use the lockfile:

```bash
npm ci
```

If dependency installation fails because the network is unavailable, report that plainly. Do not edit package files to work around network failure.

## 3. Create `.env` Without Overwriting

Never overwrite an existing `.env`.

```bash
test -f .env || cp .env.example .env
```

Then edit `.env` to use isolated paths:

```dotenv
MOSSBRIDGE_RUNTIME=codex
MOSSBRIDGE_STATE_DIR=/tmp/mossbridge-smoke/state
MOSSBRIDGE_DATA_ROOT=/tmp/mossbridge-smoke/data
MOSSBRIDGE_WORKSPACE_ROOT=/tmp/mossbridge-smoke/workspace
MOSSBRIDGE_ALLOWED_USER_IDS=
MOSSBRIDGE_ALLOW_OPEN_INBOUND=false
MOSSBRIDGE_ENABLE_CHECKIN=false
MOSSBRIDGE_ENABLE_DREAMING=false
```

For Claude Code:

```dotenv
MOSSBRIDGE_RUNTIME=claudecode
# Optional: leave MOSSBRIDGE_CLAUDE_MODEL unset to use the local Claude Code default.
```

For Codex model/provider experiments, use:

```dotenv
MOSSBRIDGE_CODEX_MODEL=
MOSSBRIDGE_CODEX_MODEL_PROVIDER=
MOSSBRIDGE_CODEX_NATIVE_IMAGE_INPUT=
MOSSBRIDGE_CODEX_COMMAND=
MOSSBRIDGE_CODEX_RPC_REQUEST_TIMEOUT_MS=45000
MOSSBRIDGE_CODEX_MODEL_CHOICES=cloud=gpt-5.4,local=gemma4:26b-32k@ollama
# Optional alpha: ordinary Codex foreground chat companion base. Default off.
MOSSBRIDGE_CODEX_COMPANION_PROFILE=false
# MOSSBRIDGE_CODEX_COMPANION_INSTRUCTIONS_FILE=
```

These `MOSSBRIDGE_CODEX_*` variables do not configure Claude Code. If `MOSSBRIDGE_RUNTIME=claudecode`, leave Codex-only variables unused unless the user is preparing a separate Codex runtime smoke.

`MOSSBRIDGE_CODEX_COMPANION_PROFILE=true` is optional and reversible. In the public alpha it applies only to ordinary Codex foreground chat by sending a short neutral base instruction through `thread/start` and `thread/resume`; it does not rewrite task/full/check-in lanes, does not change the MCP tool surface, and does not provide process-level Codex home isolation.

For shared runtime behavior, keep using the neutral variables:

```dotenv
MOSSBRIDGE_ENV_FILE=
MOSSBRIDGE_RUNTIME=
MOSSBRIDGE_STATE_DIR=
MOSSBRIDGE_DATA_ROOT=
MOSSBRIDGE_WORKSPACE_ROOT=
MOSSBRIDGE_ALLOWED_USER_IDS=
MOSSBRIDGE_ENABLE_CHECKIN=
MOSSBRIDGE_ENABLE_DREAMING=
# Leave unset for runtime-aware defaults: Codex about 76%, Claude Code/others 92%.
MOSSBRIDGE_SESSION_REFRESH_PRESSURE_PERCENT=
```

`MOSSBRIDGE_ENV_FILE` is a launcher/service variable. Set it in the shell, LaunchAgent, or wrapper process that starts Mossbridge; do not rely on a file to point at itself.

The recommended default is the repository-root `.env`; `MOSSBRIDGE_ENV_FILE` is an advanced path for wrappers or services, and shared scripts plus the app entrypoint read it with the same priority.

Do not fork shared behavior into two `.env` files unless the user is deliberately running two separate deployments with separate state/data/workspace roots.

Session refresh is a queued boundary action, not an immediate runtime kill. Codex can queue from live context telemetry or the read-only session JSONL fallback when the snapshot belongs to the bound thread. The queued request waits for the next normal foreground user message; check-in, dreaming, and other system turns must not consume it. Automatic lifecycle continuity stays in the control plane and should not inject old thread ids, maintenance reasons, or raw recent tail into runtime prompts. When the current user explicitly asks to continue or quote recent context, bounded recent-thread recall remains available.

Do not set migration-only memory overrides for a first deployment:

```dotenv
# MOSSBRIDGE_ASHERIE_WARM_MEMORY_DIR=
# MOSSBRIDGE_ASHERIE_TRUTH_LAYER_DIR=
# MOSSBRIDGE_ASHERIE_MEMORY_TREE_DIR=
# MOSSBRIDGE_ASHERIE_CASE_INDEX_DIR=
# MOSSBRIDGE_ASHERIE_MEMORY_VERSION_BANK_DIR=
```

The `ASHERIE` segment is historical memory-domain naming. It is not a requirement to connect a private Home system.

## 4. Create Isolated Directories

```bash
mkdir -p /tmp/mossbridge-smoke/state
mkdir -p /tmp/mossbridge-smoke/data
mkdir -p /tmp/mossbridge-smoke/workspace
```

Use equivalent user-selected paths if `/tmp` is not appropriate. Keep them outside the git repository. Treat `/tmp` as disposable: do not use these paths for ongoing QR operation, service install, service takeover, or memory import apply.

Before the user approves QR login for a real deployment, require persistent paths, for example:

```dotenv
MOSSBRIDGE_STATE_DIR=/Users/the-user/.mossbridge
MOSSBRIDGE_DATA_ROOT=/Users/the-user/MossbridgeData
MOSSBRIDGE_WORKSPACE_ROOT=/Users/the-user/MossbridgeWorkspace
```

## 5. Run Safe Checks

These checks do not require QR login:

```bash
npm run doctor
npm run smoke:memory-empty
npm run smoke:memory-chain
npm run verify
```

Expected meaning:

- `doctor`: config and local component description.
- `smoke:memory-empty`: empty local brain can build its storage/cache skeleton and context packet.
- `smoke:memory-chain`: isolated stores can write and recall representative memory/case/notebook/sticker/metabolism data.
- `verify`: `npm run check` plus `npm test`.

These checks do not prove real WeChat delivery. Do not report QR/first-reply as passed unless a human actually scanned and observed it.

## 6. QR/Login And Start Only After User Approval

Only after the user asks for a real local smoke, and only after the state/data/workspace paths are appropriate for the intended scope:

```bash
npm run login
```

Then start passively:

```bash
npm run shared:start
```

Do not start service guard yet. Keep the foreground terminal visible until first reply smoke passes.

## 7. Identify And Lock The Sender

`MOSSBRIDGE_ALLOWED_USER_IDS=` is closed by default. With `MOSSBRIDGE_ALLOW_OPEN_INBOUND=false`, normal WeChat inbound is rejected.

Preferred sender-id sources:

1. The `userId` printed by successful QR login.
2. `npm run accounts`.
3. A temporary enrollment window with `MOSSBRIDGE_ALLOW_OPEN_INBOUND=true`, only if the first two do not expose the sender id needed for the chat.

After identifying the sender id, set:

```dotenv
MOSSBRIDGE_ALLOWED_USER_IDS=the_confirmed_sender_id
MOSSBRIDGE_ALLOW_OPEN_INBOUND=false
```

Restart the bridge after editing `.env`.

When non-empty, the allowlist rejects unauthorized senders before command parsing, binding changes, attachment download, context-token caching, and runtime dispatch.

## 8. Foreground Smoke Before Proactive Features

In WeChat:

```text
/bind /tmp/mossbridge-smoke/workspace
/status
```

Use the `/tmp` workspace only for disposable smoke. For persistent deployment, bind the persistent workspace path.

Then send one ordinary message. Pass criteria:

- WeChat receives a normal reply.
- `/status` shows the expected runtime and workspace.
- `MOSSBRIDGE_STATE_DIR` has account/session/log/control files for this isolated deployment.
- `MOSSBRIDGE_DATA_ROOT` has local storage/cache directories and no dependency on an old private warehouse.

Only after this passes may the user opt into proactive behavior:

```bash
npm run shared:start:checkin
# or
MOSSBRIDGE_ENABLE_CHECKIN=true npm run shared:start
```

Dreaming/metabolism is also opt-in:

```bash
MOSSBRIDGE_ENABLE_DREAMING=true npm run shared:start
```

Do not enable check-in, dreaming, or service guard before foreground smoke works.

## 9. Service Guard Is macOS-Only

LaunchAgent commands are macOS-only. Use them only after foreground smoke works.

```bash
npm run service:install:codex
npm run service:status:codex
```

For Claude Code deployments:

```bash
npm run service:install:claudecode
npm run service:status:claudecode
```

When `.env` has `MOSSBRIDGE_RUNTIME=claudecode`, do not run `service:install:codex`, `service:status:codex`, `service:restart:codex`, or `service:takeover:codex`. Use the matching `:claudecode` scripts.

Use takeover only when the user intentionally wants to replace an existing Mossbridge LaunchAgent:

```bash
# Codex runtime only
npm run service:takeover:codex

# Claude Code runtime only
npm run service:takeover:claudecode
```

Do not run service restart/takeover as a generic troubleshooting step, and do not cross runtimes when choosing the service command.

Service install/start/restart rejects `/tmp`, `/private/tmp`, or `os.tmpdir()` state/data/workspace paths by default. Only for a disposable service smoke, and only with explicit user approval, call `node ./scripts/launchd-service.js install --allow-ephemeral`.

## 10. Old Memory Migration

Default route:

```text
memory:export -> dry-run memory:import -> isolated apply -> foreground smoke
```

Export from the old source:

```bash
npm run memory:export -- --source-data-root /path/to/source-data --out /tmp/mossbridge-memory-bundle --replace-output
```

Dry-run import:

```bash
npm run memory:import -- --bundle /tmp/mossbridge-memory-bundle
```

Apply only into an isolated target:

```bash
MOSSBRIDGE_STATE_DIR=/tmp/mossbridge-import/state \
MOSSBRIDGE_DATA_ROOT=/tmp/mossbridge-import/data \
npm run memory:import -- --bundle /tmp/mossbridge-memory-bundle --apply
```

Do not point a new deployment directly at a live data root as the first migration step.

## 11. Resident Anchors Are Optional

Do not write a resident anchor automatically.

Allowed path:

1. The user has completed at least one foreground conversation.
2. The user explicitly confirms the memory content.
3. The assistant writes a first-person warm card only if useful.

Resident anchors are for confirmed continuity. They are not setup placeholders, relationship guesses, safety promises, or identity templates.

## 12. What To Report

A deployment helper should report:

- Node/runtime/platform facts.
- Which isolated paths were used.
- Which commands were actually run.
- Which checks passed or failed.
- Whether QR login and first WeChat reply were actually performed by a human.
- Whether allowlist was filled after sender id confirmation.
- Whether check-in/dreaming/service guard remain off or were explicitly enabled.

Do not report unperformed human validation as passed.

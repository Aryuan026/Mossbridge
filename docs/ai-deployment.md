# AI Deployment Guide

This guide is for an AI assistant helping a user deploy Mossbridge from a clean clone. Treat the repository and package scripts as the source of truth. Do not copy old private deployment habits into a public install.

Mossbridge supports both Codex and Claude Code as runtimes. In this document, "AI deployment helper" means the assistant doing setup work; "runtime" means the local `codex` or `claude` command that will answer WeChat turns.

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
MOSSBRIDGE_ENABLE_CHECKIN=false
MOSSBRIDGE_ENABLE_DREAMING=false
```

For Claude Code:

```dotenv
MOSSBRIDGE_RUNTIME=claudecode
MOSSBRIDGE_CLAUDE_MODEL=claude-opus-4-6
```

For Codex model/provider experiments, use:

```dotenv
MOSSBRIDGE_CODEX_MODEL=
MOSSBRIDGE_CODEX_MODEL_PROVIDER=
MOSSBRIDGE_CODEX_NATIVE_IMAGE_INPUT=
MOSSBRIDGE_CODEX_COMMAND=
MOSSBRIDGE_CODEX_MODEL_CHOICES=cloud=gpt-5.4,local=gemma4:26b-32k@ollama
```

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

Use equivalent user-selected paths if `/tmp` is not appropriate. Keep them outside the git repository.

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

Only after the user asks for a real local smoke:

```bash
npm run login
```

Then start passively:

```bash
npm run shared:start
```

Do not start service guard yet. Keep the foreground terminal visible until first reply smoke passes.

## 7. Identify And Lock The Sender

During first isolated login, `MOSSBRIDGE_ALLOWED_USER_IDS=` may be empty because the sender id is not known yet. This is a diagnostic posture, not a safe ongoing configuration.

After the first incoming message or `/status`, identify the sender id from bridge status/logs, then set:

```dotenv
MOSSBRIDGE_ALLOWED_USER_IDS=the_confirmed_sender_id
```

Restart the bridge after editing `.env`.

When non-empty, the allowlist rejects unauthorized senders before command parsing, binding changes, attachment download, context-token caching, and runtime dispatch.

## 8. Foreground Smoke Before Proactive Features

In WeChat:

```text
/bind /tmp/mossbridge-smoke/workspace
/status
```

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

Use takeover only when the user intentionally wants to replace an existing Mossbridge LaunchAgent:

```bash
npm run service:takeover:codex
```

Do not run service restart/takeover as a generic troubleshooting step.

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

# Mossbridge Quickstart

This guide is the human clean-clone path: new state directory, new data directory, disposable workspace, and either Codex or Claude Code as the runtime.

Do not reuse another bridge's state directory, launchd label, account files, memory warehouse, or workspace while running this smoke. The whole point is to prove Mossbridge can stand up from an empty little patch of ground.

Mossbridge has its own local brain and a small control plane. During this quickstart, `MOSSBRIDGE_DATA_ROOT` proves the brain can start empty, and `MOSSBRIDGE_STATE_DIR/control-events.jsonl` proves automatic bridge decisions can be reviewed without becoming user memory.

## 1. Prerequisites

- Node.js 22 or newer
- A local `codex` command for Codex runtime, already authenticated
- Or a local `claude` command for Claude Code runtime, already authenticated
- A WeChat account that can complete the QR login flow

## 2. Install

```bash
git clone https://github.com/Aryuan026/Mossbridge.git
cd Mossbridge
npm ci
test -f .env || cp .env.example .env
```

## 3. Create Isolated Paths

Use paths that are safe to delete after testing:

```bash
mkdir -p /tmp/mossbridge-smoke/workspace
mkdir -p /tmp/mossbridge-smoke/state
mkdir -p /tmp/mossbridge-smoke/data
```

Set these in `.env`:

```dotenv
MOSSBRIDGE_RUNTIME=codex
MOSSBRIDGE_WORKSPACE_ROOT=/tmp/mossbridge-smoke/workspace
MOSSBRIDGE_STATE_DIR=/tmp/mossbridge-smoke/state
MOSSBRIDGE_DATA_ROOT=/tmp/mossbridge-smoke/data
MOSSBRIDGE_ALLOWED_USER_IDS=
MOSSBRIDGE_ENABLE_CHECKIN=false
MOSSBRIDGE_ENABLE_DREAMING=false
MOSSBRIDGE_IDENTITY_USER_ID=owner
MOSSBRIDGE_IDENTITY_REALM_ID=default
MOSSBRIDGE_IDENTITY_AGENT_ID=moss
```

For Claude Code, change only:

```dotenv
MOSSBRIDGE_RUNTIME=claudecode
MOSSBRIDGE_CLAUDE_MODEL=claude-opus-4-6
```

Leave migration-only memory overrides unset for a first run.

Why these paths matter:

- `MOSSBRIDGE_STATE_DIR` proves QR login, sessions, logs, queues, and cooldowns can be created without touching another bridge.
- `MOSSBRIDGE_DATA_ROOT` proves hot context, notebook notes, warm memory, ongoing tracks, journals, case index, cold-version compatibility, and mutation logs can start from an empty warehouse.
- `MOSSBRIDGE_WORKSPACE_ROOT` gives the runtime a safe file area for `/bind`, attachments, and first project work.
- `MOSSBRIDGE_IDENTITY_*` scopes the memory files. Keep them stable after first deployment so future imports and recalls land in the same identity tree.

Before QR login, you can verify the empty memory warehouse skeleton:

```bash
npm run doctor
npm run smoke:memory-empty
npm run smoke:memory-chain
npm run verify
```

The first smoke creates the local storage/cache directories and checks that an empty context packet can be built without touching any external memory warehouse. The second writes a disposable warm card, ongoing track, observation, episode, case, solitude note, notebook entry, conversation-cache record, local web AI capture import, sticker catalog, and dreaming receipt into the isolated data/state roots, then verifies the bridge can recall the core context and complete the quiet-window metabolism gate.

## 4. QR Login

Run:

```bash
npm run login
```

Scan the QR code in WeChat. When login succeeds, Mossbridge prints an `accountId` and usually a `userId`.

For a private deployment, put the user id into `.env`:

```dotenv
MOSSBRIDGE_ALLOWED_USER_IDS=the_user_id_from_login_or_status
```

For an isolated smoke test, it is acceptable to leave it empty until you confirm which user id arrives from WeChat. After you know the sender id, fill it and restart the bridge. A non-empty allowlist rejects other senders before commands, attachment downloads, token caching, and runtime dispatch.

## 5. Start The Shared Bridge

Codex runtime:

```bash
npm run shared:start
```

Claude Code runtime:

```bash
npm run shared:start:claudecode
```

Keep this terminal open. In another terminal, check status:

```bash
npm run shared:status
```

For Claude Code:

```bash
npm run shared:status:claudecode
```

## 6. Bind A Workspace In WeChat

Send this in the WeChat chat that should control the bridge:

```text
/bind /tmp/mossbridge-smoke/workspace
```

Then send:

```text
/status
```

The status should show the runtime you selected and the workspace path you bound.

## 7. First Reply Smoke

Send one ordinary message, for example:

```text
Please reply in one short sentence and confirm which runtime you are using.
```

Pass criteria:

- WeChat receives a normal reply.
- `/status` shows the intended workspace and runtime.
- `MOSSBRIDGE_STATE_DIR` contains accounts, logs, sessions, control events, and generated bridge files.
- `MOSSBRIDGE_STATE_DIR/control-events.jsonl` contains operational events such as runtime dispatch, memory delivery, check-in skip/queue, cooldown, or deferred delivery when those paths occur.
- `MOSSBRIDGE_DATA_ROOT` creates memory folders under `storage/` or `cache/` without depending on any existing personal warehouse.
- Asking about memory in an empty warehouse does not crash the bridge.

## 8. Optional Service Guard

Only use the service guard after the foreground smoke works. These LaunchAgent commands are macOS-only.

Codex:

```bash
npm run service:install:codex
npm run service:status:codex
```

Claude Code:

```bash
npm run service:install:claudecode
npm run service:status:claudecode
```

The default LaunchAgent label is `com.mossbridge.bridge`. Use `service:takeover:*` only when intentionally replacing an existing Mossbridge LaunchAgent. Use a custom `MOSSBRIDGE_LAUNCHD_LABEL` if you intentionally run multiple isolated deployments on one Mac.

## 9. Optional Proactive Features

The public default is passive. Enable proactive check-ins only after the foreground smoke works and the user wants them:

```bash
npm run shared:start:checkin
```

Dreaming/metabolism is also explicit opt-in:

```bash
MOSSBRIDGE_ENABLE_DREAMING=true npm run shared:start
```

## 10. Codex As Deployment Helper

Codex can help a new maintainer run these checks, inspect logs, and patch local setup issues. That is separate from Codex as a runtime: `MOSSBRIDGE_RUNTIME=codex` means WeChat messages are handled by the local Codex runtime through the bridge.

## Current Public Blockers

- QR login and first WeChat reply still need to be verified on a fresh account outside the maintainer's private data roots.
- External memory import runners, automatic browser capture sync, and Notion sync are deferred extension paths. Manual web AI capture bundles can already be validated/imported into cache/hot memory, but they are not required for the first public bridge smoke.
- Historical Cyberboss wording should remain limited to upstream acknowledgement or migration notes, not runtime entrypoints or tests.

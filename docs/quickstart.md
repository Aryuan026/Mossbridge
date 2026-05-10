# Mossbridge Quickstart

This guide is the clean-clone path: new state directory, new data directory, disposable workspace, and either Codex or Claude Code as the runtime.

Do not reuse another bridge's state directory, launchd label, account files, memory warehouse, or workspace while running this smoke. The whole point is to prove Mossbridge can stand up from an empty little patch of ground.

## 1. Prerequisites

- Node.js 22 or newer
- A local `codex` command for Codex runtime, already authenticated
- Or a local `claude` command for Claude Code runtime, already authenticated
- A WeChat account that can complete the QR login flow

## 2. Install

```bash
git clone https://github.com/Aryuan026/Mossbridge.git
cd Mossbridge
npm install
cp .env.example .env
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
```

For Claude Code, change only:

```dotenv
MOSSBRIDGE_RUNTIME=claudecode
MOSSBRIDGE_CLAUDE_MODEL=claude-opus-4-6
```

Leave migration-only memory overrides unset for a first run.

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

For an isolated smoke test, it is acceptable to leave it empty until you confirm which user id arrives from WeChat.

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
- `MOSSBRIDGE_STATE_DIR` contains accounts, logs, sessions, and generated bridge files.
- `MOSSBRIDGE_DATA_ROOT` creates memory folders under `storage/` or `cache/` without depending on any existing personal warehouse.
- Asking about memory in an empty warehouse does not crash the bridge.

## 8. Optional Service Guard

Only use the service guard after the foreground smoke works.

Codex:

```bash
npm run service:takeover:codex
npm run service:status:codex
```

Claude Code:

```bash
npm run service:takeover:claudecode
npm run service:status:claudecode
```

The default LaunchAgent label is `com.mossbridge.bridge`. Use a custom `MOSSBRIDGE_LAUNCHD_LABEL` if you intentionally run multiple isolated deployments on one Mac.

## 9. Codex As Deployment Helper

Codex can help a new maintainer run these checks, inspect logs, and patch local setup issues. That is separate from Codex as a runtime: `MOSSBRIDGE_RUNTIME=codex` means WeChat messages are handled by the local Codex runtime through the bridge.

## Current Public Blockers

- QR login and first WeChat reply still need to be verified on a fresh account outside the maintainer's private data roots.
- External memory imports from GPT, Rikkahub, Driftstone, and Notion staging still need isolated warm/cold/episode write tests.
- Historical Cyberboss wording should remain limited to upstream acknowledgement or migration notes, not runtime entrypoints or tests.

# Mossbridge

**Public Preview / self-hosted alpha.**

Mossbridge, or 苔藓小桥, is a local-first WeChat bridge for Codex and Claude Code. It lets one local runtime receive WeChat messages, send replies, handle files/stickers, keep a shared runtime thread, and use a local memory layer under a data directory you control.

This is suitable today for technical users who can read logs, run local CLIs, and keep state/data directories separate. It is not marked Stable or Production Ready.

Mossbridge is derived from [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss). It is a modified fork, not an official Cyberboss release, and follows the same `AGPL-3.0-only` license. See [NOTICE.md](./NOTICE.md) and [LICENSE](./LICENSE).

## Current Status

- Current public status: self-hosted alpha / public preview.
- Runtime support: Codex and Claude Code are both first-class runtimes.
- Current verified development platform: macOS with Node.js 22. LaunchAgent commands are macOS-only.
- Not yet claimed: cross-platform service management, clean-account QR login plus first WeChat reply by an unrelated public tester, or production readiness.
- Default local state: `~/.mossbridge`.
- Default launchd label: `com.mossbridge.bridge`.

Read the current release status before publishing or demoing a clone: [docs/release-status.md](./docs/release-status.md).

## What It Does

Mossbridge is intentionally split into five parts:

```text
WeChat mouth
  -> bridge core and tools
  -> Codex / Claude Code runtime engine
  -> local brain under MOSSBRIDGE_DATA_ROOT
  -> control plane ledger under MOSSBRIDGE_STATE_DIR
```

- **Mouth**: WeChat QR login, polling, reply delivery, chunks, attachments, stickers, and bridge notices.
- **Hands**: local tools for files, reminders, notebook notes, stickers, timeline/status checks, and memory operations.
- **Engines**: Codex and Claude Code adapters. Runtime-specific protocol, session, model, and approval handling belongs here.
- **Brain**: local memory stores under `MOSSBRIDGE_DATA_ROOT`, including hot context, warm cards, notebook, ongoing tracks, observation/episode journals, case index, conversation cache, and cold-version compatibility.
- **Control plane**: operational events under `MOSSBRIDGE_STATE_DIR/control-events.jsonl`, recording why a turn, wakeup, cooldown, memory delivery, or dreaming attempt happened.

Shared behavior should live in bridge core. Only protocol differences should live in runtime adapters.

## Requirements

- Node.js `>= 22`
- A local authenticated `codex` command for Codex runtime, or a local authenticated `claude` command for Claude Code runtime
- A WeChat account that can complete the local QR login flow
- Separate local directories for state, data, and workspace
- Chrome / Chromium / Edge only if screenshot features are used

## Clean Install

```bash
git clone https://github.com/Aryuan026/Mossbridge.git
cd Mossbridge
npm ci
test -f .env || cp .env.example .env
```

For an AI deployment helper, use [docs/ai-deployment.md](./docs/ai-deployment.md). For a human quick path, use [docs/quickstart.md](./docs/quickstart.md).

Do not overwrite an existing `.env`. Do not point a clean clone at another bridge's state directory, live WeChat account files, or a shared personal memory warehouse.

The recommended default is the repository-root `.env`; `MOSSBRIDGE_ENV_FILE` is an advanced launcher/service path, and both shared scripts and the app entrypoint read it with the same priority.

## Minimal Configuration

For a disposable smoke, create directories that are safe to delete:

```bash
mkdir -p /tmp/mossbridge-smoke/state
mkdir -p /tmp/mossbridge-smoke/data
mkdir -p /tmp/mossbridge-smoke/workspace
```

Set the same shape in `.env`:

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

`/tmp` is only for throwaway smoke checks. Before QR login for real use, and always before `service:install:*` or `service:takeover:*`, switch `MOSSBRIDGE_STATE_DIR`, `MOSSBRIDGE_DATA_ROOT`, and `MOSSBRIDGE_WORKSPACE_ROOT` to persistent paths chosen by the operator, such as directories under the user's home folder.

For Claude Code:

```dotenv
MOSSBRIDGE_RUNTIME=claudecode
# Optional: leave MOSSBRIDGE_CLAUDE_MODEL unset to use the local Claude Code default.
```

Optional Codex runtime controls:

```dotenv
MOSSBRIDGE_CODEX_MODEL=
MOSSBRIDGE_CODEX_MODEL_PROVIDER=
MOSSBRIDGE_CODEX_NATIVE_IMAGE_INPUT=
MOSSBRIDGE_CODEX_COMMAND=
# Optional: env values are clamped to 5000..120000 ms.
MOSSBRIDGE_CODEX_RPC_REQUEST_TIMEOUT_MS=45000
MOSSBRIDGE_CODEX_MODEL_CHOICES=cloud=gpt-5.4,local=gemma4:26b-32k@ollama
# Optional alpha: ordinary Codex foreground chat companion base. Default off.
MOSSBRIDGE_CODEX_COMPANION_PROFILE=false
# MOSSBRIDGE_CODEX_COMPANION_INSTRUCTIONS_FILE=
```

For local providers such as Ollama, copy [templates/codex-local-provider.sh](./templates/codex-local-provider.sh) outside the repo, make it executable, and set `MOSSBRIDGE_CODEX_COMMAND` to that copy.

`MOSSBRIDGE_CODEX_COMPANION_PROFILE=true` is an optional alpha foreground-chat aid for Codex. It sends the neutral [templates/codex-companion-base.md](./templates/codex-companion-base.md) content through `thread/start` and `thread/resume` with `personality=none`, only for the ordinary foreground Codex lane. It is off by default, does not affect Claude Code, and does not claim process-level Codex home isolation in this public preview.

Runtime pressure refresh is queued, not immediate. Leave `MOSSBRIDGE_SESSION_REFRESH_PRESSURE_PERCENT` unset for runtime-aware defaults: Codex queues at about 76% of the actual context window, while Claude Code and other runtimes use 92%. The queued refresh waits for the next normal foreground user message, preserves a short post-refresh recent-tail grace, and is not consumed by check-ins, dreaming, or other system turns. Set it to `0` to disable, or set an explicit percent if a deployment has its own tested threshold.

## Access Control

`MOSSBRIDGE_ALLOWED_USER_IDS` protects the normal WeChat inbound chain.

- Empty allowlist is closed by default: normal WeChat inbound is rejected unless `MOSSBRIDGE_ALLOW_OPEN_INBOUND=true`.
- `MOSSBRIDGE_ALLOW_OPEN_INBOUND=true` is temporary enrollment only. Use it just long enough to identify the sender id, then turn it off.
- Non-empty allowlist: only listed sender ids may enter the bridge.
- Unauthorized senders are rejected before command parsing, binding changes, attachment download, token caching, and runtime dispatch.
- Logs record presence/ids and short operational previews, not context tokens or full private message bodies.

Prefer the `userId` printed by QR login, then `npm run accounts`, as the sender-id source. If the login output does not expose the sender you need, temporarily enable enrollment for one isolated foreground smoke and inspect `/status` or bridge status output. Then fill:

```dotenv
MOSSBRIDGE_ALLOWED_USER_IDS=the_sender_id_you_confirmed
MOSSBRIDGE_ALLOW_OPEN_INBOUND=false
```

Then restart the bridge.

## Passive By Default

Public installs are passive by default:

- `npm run shared:start` starts the shared bridge without random check-ins.
- `MOSSBRIDGE_ENABLE_CHECKIN=false` is the example default.
- `MOSSBRIDGE_ENABLE_DREAMING=false` is the example default.

Enable proactive behavior only after the foreground smoke works and the user asks for it:

```bash
npm run shared:start:checkin
# or
MOSSBRIDGE_ENABLE_CHECKIN=true npm run shared:start
```

Dreaming/metabolism is also opt-in:

```bash
MOSSBRIDGE_ENABLE_DREAMING=true npm run shared:start
```

## Verification

These commands do not require QR login when run against isolated paths:

```bash
npm run doctor
npm run smoke:memory-empty
npm run smoke:memory-chain
npm run verify
```

`npm run verify` runs syntax checks and the Node test suite. It does not prove a real WeChat account can reply; that still needs a human QR/first-reply smoke.

## Start Only When Asked

Only run QR login, bridge start, or service takeover when the user explicitly asks for a local deployment smoke:

```bash
npm run login
npm run shared:start
```

Then, in WeChat. For disposable smoke only:

```text
/bind /tmp/mossbridge-smoke/workspace
/status
```

Send one ordinary message and confirm a normal reply. Do not call this passed until a human has scanned QR and observed the first reply.

For persistent use, bind the persistent workspace path, not `/tmp`.

LaunchAgent/service commands are macOS-only:

```bash
npm run service:install:codex
npm run service:status:codex
npm run service:stop:codex
```

Use `service:install:claudecode` and `service:status:claudecode` for Claude Code deployments. Use `service:takeover:*` only when intentionally replacing an existing Mossbridge LaunchAgent. Service install/start/restart refuses `/tmp`, `/private/tmp`, or `os.tmpdir()` state/data/workspace paths unless `--allow-ephemeral` is passed directly to `scripts/launchd-service.js` for a disposable service smoke.

## Memory And Data Boundaries

An empty `MOSSBRIDGE_DATA_ROOT` is a valid starting state. The bridge should be able to talk before any resident anchor, imported history, browser capture, or Notion sync exists.

Resident warm anchors are optional. They should only be written after the first conversation, when the user explicitly confirms the content. Do not seed relationship/persona/user facts before QR login, and do not let an AI deployment helper guess the user's name, gender, relationship, diagnosis, preferences, or identity.

Old memory should move through portable bundles:

```bash
npm run memory:export -- --source-data-root /path/to/source-data --out /tmp/mossbridge-memory-bundle --replace-output
npm run memory:import -- --bundle /tmp/mossbridge-memory-bundle
```

`memory:import` is dry-run by default. Apply only into an isolated target:

```bash
MOSSBRIDGE_STATE_DIR=/tmp/mossbridge-import/state \
MOSSBRIDGE_DATA_ROOT=/tmp/mossbridge-import/data \
npm run memory:import -- --bundle /tmp/mossbridge-memory-bundle --apply
```

Do not make a new public deployment point directly at a live shared data root.

## Useful Commands

```bash
npm run doctor
npm run shared:status
npm run shared:open
npm run shared:model
npm run shared:refresh-session
```

WeChat commands include:

- `/bind /absolute/path`
- `/status`
- `/model`
- `/model <id>`
- `/model --provider <id> <model>`
- `/model default`
- `/model refresh`
- `/reread`
- `/checkin <min>-<max>`
- `/chunk <number>`

See [docs/commands.md](./docs/commands.md).

## Known Limitations

- Fresh clean-account QR login and first WeChat reply still require human validation for each public deployment.
- Write-ahead/orphan mutation recovery for the memory mutation ledger is not complete. A crash between store mutation and ledger write is still a known durability gap.
- Automatic browser conversation capture is a future extension. Current app daily capture import is manual and staged.
- Notion synchronization is a future extension, not part of first-run setup.
- The memory system is local-file based and still in alpha. It has tests and smoke checks, but not a production data durability guarantee.
- launchd service scripts are macOS-only. Other platforms may run the Node process manually, but service management is not claimed as verified.

## Docs

- [docs/ai-deployment.md](./docs/ai-deployment.md)
- [docs/quickstart.md](./docs/quickstart.md)
- [docs/release-status.md](./docs/release-status.md)
- [docs/architecture-for-humans.md](./docs/architecture-for-humans.md)
- [docs/brain-layer-boundary.md](./docs/brain-layer-boundary.md)
- [docs/memory-storage.md](./docs/memory-storage.md)
- [docs/memory-portability.md](./docs/memory-portability.md)
- [docs/app-daily-capture-json.md](./docs/app-daily-capture-json.md)
- [docs/safe-self-check.md](./docs/safe-self-check.md)

## License

Mossbridge follows upstream cyberboss under `AGPL-3.0-only`. This public alpha is shared for self-hosting, study, and prototype evaluation. See [LICENSE](./LICENSE) for the full license text.

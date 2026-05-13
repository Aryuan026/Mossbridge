# Runtime-Neutral Public Readiness

Mossbridge should stay runtime-neutral.

The current private test lane often uses Claude Code, but Mossbridge inherits the Cyberboss shape where WeChat can speak to a local runtime through a common bridge. Codex and Claude Code are both first-class runtime targets. Ease-of-use, startup safety, memory bootstrap, wakeups, attachment handling, and user-readable failure recovery should live in shared bridge code unless a runtime adapter has a real protocol-specific reason to diverge.

## Public Readiness Goal

A new user should be able to clone Mossbridge, choose `codex` or `claudecode`, and reach a working WeChat bridge without the maintainer's private paths, memories, accounts, or private external memory warehouse.

Codex can also help a human deploy the project, but that is a helper role. It does not replace `codex` as a runtime target.

The expected public direction is OpenAI-user continuity: ChatGPT daily
conversation and future ChatGPT web/app captures should enter Mossbridge as data
sediment, Codex should be able to help deploy and maintain the bridge, and
WeChat should continue the same memory/personality posture. Mossbridge should
not expose private external executor tools that cannot be configured and audited
as Mossbridge-native adapters.

## Runtime Matrix

| Area | Shared expectation | Codex runtime | Claude Code runtime |
| --- | --- | --- | --- |
| Install | `npm install` succeeds on a clean clone | `codex` command is available and authenticated | `claude` command is available and authenticated |
| Start | shared bridge starts with `--checkin` support | `npm run shared:start` or `MOSSBRIDGE_RUNTIME=codex npm run shared:start` | `npm run shared:start:claudecode` |
| Local guard | launchd can supervise the same shared-start wrapper | `npm run service:takeover:codex` | `npm run service:takeover:claudecode` |
| Status | one status surface shows runtime, pid, workspace, thread, and context health | `npm run shared:status` / `npm run service:status:codex` | `npm run shared:status:claudecode` / `npm run service:status:claudecode` |
| WeChat login | QR login and allowed-user binding are runtime-independent | same account store | same account store |
| Workspace bind | `/bind` maps WeChat to a workspace | Codex thread stored in session store | Claude Code session stored in session store |
| Memory | warm memory, ongoing tracks, observation journal, episode journal, conversation cache use the same data root | same tools/context packet | same tools/context packet via MCP config |
| App capture | ChatGPT web/app daily captures land in `cache/app_daily_captures/` before normalization | Codex can help inspect/import captures | Claude Code can read the same normalized memory once imported |
| Wakeups | reminders and random checkins use the same system-turn queue and failure throttling | Codex adapter handles thread/RPC failure | Claude Code adapter handles session/API-result failure |
| Nightly dreaming | quiet-window dreaming trigger, mutation log, memory writeback, and visible failure notices are owned by shared bridge code | Codex executes the shared dreaming JSON contract | Claude Code executes the shared dreaming JSON contract |
| Attachments | WeChat image/file intake, batching, inbox, and notes are shared | same prepared inbound text | same prepared inbound text, with local image `Read` guidance |
| Failure visibility | runtime errors become user-readable bridge notices and do not enter assistant memory text | auth/RPC/compact failures covered | 400/prompt-too-long/session-id failures covered |

## Clean-Clone Smoke

Use a new state directory, new data directory, and disposable workspace. Do not point at a private external memory warehouse for this smoke.

```bash
git clone https://github.com/Aryuan026/Mossbridge.git
cd Mossbridge
npm install
cp .env.example .env
```

Fill only the neutral essentials first:

```dotenv
MOSSBRIDGE_RUNTIME=codex
MOSSBRIDGE_WORKSPACE_ROOT=/absolute/path/to/mossbridge-workspace
MOSSBRIDGE_STATE_DIR=/absolute/path/to/mossbridge-state
MOSSBRIDGE_DATA_ROOT=/absolute/path/to/mossbridge-data
MOSSBRIDGE_ALLOWED_USER_IDS=
MOSSBRIDGE_IDENTITY_USER_ID=owner
MOSSBRIDGE_IDENTITY_REALM_ID=default
MOSSBRIDGE_IDENTITY_AGENT_ID=moss
```

For Claude Code, change only:

```dotenv
MOSSBRIDGE_RUNTIME=claudecode
MOSSBRIDGE_CLAUDE_MODEL=claude-opus-4-6
```

Then run the same smoke twice, once per runtime:

```bash
npm run login
npm run shared:start
npm run shared:status
```

For Claude Code:

```bash
npm run shared:start:claudecode
npm run shared:status:claudecode
```

In WeChat:

```text
/bind /absolute/path/to/mossbridge-workspace
/status
```

Pass criteria:

- WeChat receives one normal reply.
- `/status` shows the intended workspace and runtime.
- The data root creates `storage/` and `cache/` without private external paths.
- Asking "你能看看记忆里有什么吗" does not fail on an empty warehouse.
- A warm memory write/read path can be exercised through the model tools.
- A reminder or checkin can be scheduled or triggered without crashing the bridge.
- A quiet-window dreaming run can write a visible mutation log without any private external scheduler process.
- A dreaming schedule item is not marked complete merely because it was triggered; completion requires a successful mutation/writeback receipt.
- If dreaming is held because the user is still active, or fails because the runtime/JSON/writeback path breaks, the same item is delayed and retried with visible retry metadata.

## Service Smoke

The local service guard should work for both runtimes. Only one default LaunchAgent label should be active at a time unless the user deliberately sets distinct labels.

Codex:

```bash
npm run service:takeover:codex
npm run service:status:codex
npm run service:restart:codex
```

Claude Code:

```bash
npm run service:takeover:claudecode
npm run service:status:claudecode
npm run service:restart:claudecode
```

Pass criteria:

- The launchd service is loaded.
- The bridge pid is alive.
- `requested_runtime` and `installed_runtime` match in `service:status:*`.
- Stopping the terminal does not stop the bridge.
- Restarting the service does not erase state or stable memory.

## Failure-Recovery Smoke

The exact failure shapes differ by runtime, but the user experience should be common.

Verify:

- auth failure or not-logged-in is visible to the user as a bridge/runtime issue.
- quota/API errors are visible but do not become assistant memory.
- `Prompt is too long` or equivalent context overflow clears or recovers the bad turn instead of poisoning the thread.
- WeChat context-token send failures defer or retry instead of evaporating.
- repeated proactive failures are throttled so wakeups do not spam the user.
- dreaming runtime failures are visible to the user/operator but do not become remembered conversation text.
- dreaming failures do not silently roll to the next day; they keep retrying after a delay until a real mutation/writeback succeeds or an operator explicitly intervenes.

## Public Release Blockers

Before public release, do not leave these as "private machine assumptions":

- historical `ASHERIEBRIDGE_*` or Cyberboss names outside upstream acknowledgement or migration notes
- docs that still imply Claude Code is the only normal runtime
- default state directory confusion between old private state dirs and `${HOME}/.mossbridge`
- personal absolute paths, WeChat IDs, account IDs, thread IDs, screenshots, private memories, logs, or test residue
- docs that imply a private external warehouse is required for basic use
- docs or code paths that require a private external scheduler for nightly dreaming
- public tools that bridge to private external executors
- tests that only prove Claude Code while claiming runtime-neutral stability

## Evaluation Rule

If a fix improves WeChat intake, memory routing, wakeup scheduling, local supervision, or user-visible failure handling, first ask whether it belongs in shared bridge code.

Only put logic in `adapters/runtime/codex` or `adapters/runtime/claudecode` when it depends on that runtime's protocol: RPC shape, session id, auth state, model selection, compact behavior, approval handling, or transport serialization.

# Commands

## Design Principles

`Mossbridge` does not hard-code one shared string format across terminal commands, WeChat commands, and different agent runtimes.

It defines stable internal actions first, then lets each channel expose its own entrypoints:

- core action: stable internal meaning
- terminal command: terminal entrypoint
- weixin command: WeChat entrypoint

This keeps the core naming stable when new runtimes or channels are added later.

The runtime can be `codex` or `claudecode`, but the documented command surface stays the same.

## Current Action Groups

### Lifecycle & Diagnostics

- `app.login`
- `app.accounts`
- `app.start`
- `app.shared_start`
- `app.shared_open`
- `app.shared_status`
- `app.doctor`

### Workspace & Thread

- `workspace.bind`
- `workspace.status`
- `thread.new`
- `thread.reread`
- `thread.compact`
- `thread.switch`
- `thread.stop`
- `system.checkin_range`
- `channel.chunk_min`

### Approvals & Control

- `approval.accept_once`
- `approval.accept_workspace`
- `approval.reject_once`

### Capabilities

- `model.inspect`
- `model.select`
- `channel.send_file`
- `timeline.write`
- `reminder.create`
- `diary.append`
- `app.star`
- `app.help`

## Current Terminal Commands

The intentionally small public set is:

- `npm run login`
- `npm run accounts`
- `npm run shared:start`
- `npm run shared:open`
- `npm run shared:status`
- `npm run doctor`
- `npm run help`

## Project Tools

Models no longer use local capability CLI commands for diary, reminders, timeline, screenshots, or file sending.

Those capabilities are exposed as project-native structured tools:

- `mossbridge_channel_send_file`
- `mossbridge_diary_append`
- `mossbridge_reminder_create`
- `mossbridge_system_send`
- `mossbridge_timeline_write`
- `mossbridge_timeline_build`
- `mossbridge_timeline_serve`
- `mossbridge_timeline_dev`
- `mossbridge_timeline_screenshot`

Notes:
- These tools are bound to the Mossbridge project and routed through the repo's internal tool host.
- Claude Code loads them through workspace-local `.mcp.json` injected by Mossbridge and passed to Claude at startup with `--mcp-config`.
- Codex loads them through the runtime-side Mossbridge MCP bridge configured at spawn time.
- The public human terminal surface stays intentionally small: lifecycle commands plus shared bridge scripts.

## Current WeChat Commands

- `/bind`
- `/status`
- `/new`
- `/reread`
- `/compact`
- `/stop`
- `/switch <threadId>`
- `/checkin <min>-<max>`
- `/chunk <number>`
- `/yes`
- `/always`
- `/no`
- `/model`
- `/model <id>`
- `/model default`
- `/model refresh`
- `/star`
- `/help`

Notes:

- `/status` covers thread, workspace, and context details
- there is no separate `/context` command; use `/status` and read the `📦 context` line
- `/model` is runtime-neutral: Codex uses a runtime model catalog when available, Claude Code accepts raw `--model` ids, and `/model default` clears only the workspace override
- `/model refresh` asks the runtime adapter to refresh its model catalog; runtimes without a stable catalog should report that raw model ids are accepted
- `/compact` asks the current thread to compact its context and reports start / finish back to WeChat
- file sending is still available, but no longer exposed as a WeChat command

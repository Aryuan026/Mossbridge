# Local Safety Guard

Mossbridge has two local guard layers:

- `shared-start` supervises the Bridge child process and restarts it if the child exits unexpectedly.
- macOS `launchd` can supervise `shared-start` itself, so the bridge comes back after terminal exits, process crashes, and user login.

This is intentionally a local-first guard. It does not solve WeChat login expiry, runtime quota/API errors, or memory quality by itself. It makes those failures visible and recoverable instead of letting the bridge silently disappear.

Public Mossbridge defaults to the safe self-check boundary in [safe-self-check.md](./safe-self-check.md): heartbeat checks may inspect and report, but should not silently restart services, rebind accounts, edit files, delete memory, or change credentials.

## Install On This Mac

```sh
npm run service:takeover:codex
# or
npm run service:takeover:claudecode
```

`takeover` stops a currently manual shared bridge, writes a LaunchAgent plist, and starts the launchd-owned service. Use the runtime that matches the bridge you want to run.

Default plist:

```text
~/Library/LaunchAgents/com.mossbridge.bridge.plist
```

Logs:

```text
~/.mossbridge/logs/launchd.out.log
~/.mossbridge/logs/launchd.err.log
```

## Daily Commands

Double-clickable helpers are also available at the project root:

```text
Mossbridge Start.command
Mossbridge Status.command
```

```sh
npm run service:status:codex
npm run service:restart:codex
npm run service:stop:codex
npm run service:uninstall:codex

npm run service:status:claudecode
npm run service:restart:claudecode
npm run service:stop:claudecode
npm run service:uninstall:claudecode
```

Normal Bridge status is still useful:

```sh
npm run shared:status
npm run shared:status:claudecode
npm run diagnostics:travel
```

Only one default LaunchAgent label is expected to be active at a time. If you intentionally run both runtimes side by side, give them distinct `MOSSBRIDGE_LAUNCHD_LABEL` and state directories.

`service:status:*` prints both the requested runtime and the runtime currently installed in the plist. If they differ, reinstall/take over with the runtime you intend to run.

## Failure Shape

If a runtime returns a bad result such as `API Error: 400`, malformed JSON, or `Prompt is too long`, Bridge should now treat it as `runtime.turn.failed`, clear the bad thread binding, and send a throttled user-readable notice instead of preserving the broken state as if it were a normal reply.

If the Bridge child exits, `shared-start` restarts it. If `shared-start` exits unexpectedly, `launchd` restarts it.

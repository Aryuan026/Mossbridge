# Local Safety Guard

Mossbridge has two local guard layers:

- `shared-start` supervises the Bridge child process and restarts it if the child exits unexpectedly.
- macOS `launchd` can supervise `shared-start` itself, so the bridge comes back after terminal exits, process crashes, and user login.

This is intentionally a local-first guard. It does not solve WeChat login expiry, ClaudeCode quota/API errors, or memory quality by itself. It makes those failures visible and recoverable instead of letting the bridge silently disappear.

## Install On This Mac

```sh
npm run service:takeover:claudecode
```

`takeover` stops a currently manual `npm run shared:start:claudecode` bridge, writes a LaunchAgent plist, and starts the launchd-owned service.

Default plist:

```text
~/Library/LaunchAgents/com.asherie.mossbridge.plist
```

Logs:

```text
~/.asheriebridge/logs/launchd.out.log
~/.asheriebridge/logs/launchd.err.log
```

## Daily Commands

Double-clickable helpers are also available at the project root:

```text
Mossbridge Start.command
Mossbridge Status.command
```

```sh
npm run service:status:claudecode
npm run service:restart:claudecode
npm run service:stop:claudecode
npm run service:uninstall:claudecode
```

Normal Bridge status is still useful:

```sh
npm run shared:status:claudecode
npm run diagnostics:travel
```

## Failure Shape

If ClaudeCode returns a bad runtime result such as `API Error: 400`, malformed JSON, or `Prompt is too long`, Bridge should now treat it as `runtime.turn.failed`, clear the bad thread binding, and send a throttled user-readable notice instead of preserving the broken state as if it were a normal reply.

If the Bridge child exits, `shared-start` restarts it. If `shared-start` exits unexpectedly, `launchd` restarts it.

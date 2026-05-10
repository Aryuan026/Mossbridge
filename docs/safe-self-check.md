# Safe Self-Check Policy

Mossbridge public builds default to a conservative maintenance profile.

The goal is to help Codex or a human operator see what is wrong, not to let a chat heartbeat silently repair a stranger's machine.

## Default Mode

- `MOSSBRIDGE_MAINTENANCE_PROFILE=safe_self_check`
- `MOSSBRIDGE_MAINTENANCE_ALLOW_SELF_REPAIR=false`

The heartbeat/status tool exposes this as `maintenance.action_level = read_only_report`.

## Allowed During Heartbeat

- Read bridge status, queues, pending reminders, runtime cooldowns, and context pressure.
- Skip nonessential proactive messages when runtime cooldown or context pressure is high.
- Give a short operational report if something needs attention.
- Ask the human or supervising Codex session to run an explicit repair command.

Operational diagnostics, quota notices, and failure reports must not be written into memory, dreaming input, or user-observation stores.

## Not Allowed By Default

A heartbeat should not silently:

- Restart services.
- Rebind or switch WeChat accounts.
- Edit project files.
- Delete memory, queues, cache, or test data.
- Change credentials, auth state, or runtime configuration.
- Send externally visible messages to a new channel.

If a deployer wants private-cloud behavior, they can explicitly opt in with:

```sh
MOSSBRIDGE_MAINTENANCE_PROFILE=private_cloud_ready
MOSSBRIDGE_MAINTENANCE_ALLOW_SELF_REPAIR=true
```

That opt-in is intentionally not the public default.

## Useful Checks

```sh
npm run doctor
npm run shared:status
npm run diagnostics:travel
```

The runtime-visible `mossbridge_bridge_status` tool returns the same policy boundary for agent-side self-checks.

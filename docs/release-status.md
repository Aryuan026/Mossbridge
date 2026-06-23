# Release Status

Status: **Public Preview / self-hosted alpha**.

Mossbridge is ready for technical users to inspect, run isolated checks, and attempt a supervised local WeChat smoke. It is not marked Stable or Production Ready.

## Current Scope

- Local WeChat bridge for Codex or Claude Code.
- Local state under `MOSSBRIDGE_STATE_DIR`.
- Local memory/data under `MOSSBRIDGE_DATA_ROOT`.
- Local workspace under `MOSSBRIDGE_WORKSPACE_ROOT`.
- Passive foreground operation by default.
- Optional check-in and dreaming only after explicit opt-in.

## Verified In This Repository

- Node syntax checks via `npm run check`.
- Node test suite via `npm test`.
- Empty local memory smoke via `npm run smoke:memory-empty`.
- Memory-chain smoke via `npm run smoke:memory-chain`, using isolated state/data/workspace paths.
- Allowlist behavior: unauthorized WeChat senders are rejected before command handling, attachment intake, context-token caching, and runtime dispatch.
- `shared:start` no longer forces `--checkin`; public default is passive.

## Not Yet Claimed As Verified

- A clean public tester account completing QR login and receiving the first WeChat reply.
- Cross-platform service management outside macOS.
- Production service hardening.
- Long-running public data durability under real user traffic.
- Automatic browser conversation capture.
- Notion synchronization.

## Known Limitations

- Memory mutation write-ahead/orphan recovery is not complete. If a store mutation succeeds and ledger persistence fails, the current recovery path is not yet fully durable.
- App daily capture import is manual and staged; it does not automatically promote browser/chat history into stable memory.
- Notion docs are extension notes, not first-run deployment requirements.
- `MOSSBRIDGE_ASHERIE_*` names remain in some memory-domain paths for compatibility. They are historical names, not a requirement to connect a private Home service.
- LaunchAgent scripts are macOS-only.

## Public Safety Defaults

- `MOSSBRIDGE_ENABLE_CHECKIN=false` in `.env.example`.
- `MOSSBRIDGE_ENABLE_DREAMING=false` in `.env.example`.
- Empty `MOSSBRIDGE_ALLOWED_USER_IDS` is closed by default.
- `MOSSBRIDGE_ALLOW_OPEN_INBOUND=true` is temporary enrollment only, used just long enough to identify the sender id.
- A non-empty `MOSSBRIDGE_ALLOWED_USER_IDS` is required for ongoing use.
- `/tmp` paths are disposable smoke paths only; service install/start/restart refuses ephemeral state/data/workspace unless explicitly overridden for a disposable service smoke.
- Resident anchors are optional and must be user-confirmed after first conversation.
- Old memory should migrate through `memory:export` and dry-run `memory:import`, then isolated apply.

## Current Human Acceptance Gate

Before describing a deployment as personally usable, a human should complete:

1. Clean clone.
2. `npm ci`.
3. Isolated `.env`.
4. `npm run doctor`.
5. `npm run smoke:memory-empty`.
6. `npm run smoke:memory-chain`.
7. `npm run verify`.
8. QR login.
9. Confirm sender id from QR login output, `npm run accounts`, or an explicit temporary enrollment window.
10. Fill `MOSSBRIDGE_ALLOWED_USER_IDS` and set `MOSSBRIDGE_ALLOW_OPEN_INBOUND=false`.
11. Passive `npm run shared:start`.
12. WeChat `/bind`.
13. WeChat `/status`.
14. One ordinary message receiving a normal reply.

Only steps actually run should be reported as passed.

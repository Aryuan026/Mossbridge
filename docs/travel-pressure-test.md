# Runtime Pressure Test Notes

This file is the handoff for a multi-day WeChat/runtime bridge pressure test.
It is intentionally operational rather than architectural: when the user returns, collect evidence first, then decide what to fix.

## What To Preserve

- Keep the Mac awake, powered, and online when possible.
- Keep the shared bridge process running with the selected runtime.
- Do not clear `~/.mossbridge` during the test.
- Do not delete the configured shared data root cache or storage directories.
- If a failure appears in WeChat, note the local time and the user-facing symptom before retrying.

## Primary Signals

- `WeChat transport`: inbound accepted/dispatched, context token present, no repeated `ret=-2`.
- `Runtime adapter`: first event latency, stall notices, quota/capacity notices, unexpected exits.
- `System queues`: system-message queue, deferred-system replies, reminders, and screenshot queue should not silently pile up.
- `Proactive check-in`: random check-ins should happen at the configured cadence, but skip recent active conversation.
- `Memory context`: ordinary turns should carry warm memory, ongoing tracks, observation journal only when activated, and recent-thread tail.
- `Dreaming/metabolism`: deferred for the first public version; if enabled in a pressure test, bridge-owned dreaming should see WeChat sediment and avoid private scheduler assumptions.
- `Cold tree`: do not treat lack of cold hits as failure by itself; evaluate whether topology edges and case/project provenance are useful.

## Quick Collection

From the Mossbridge repo:

```bash
node scripts/collect-travel-diagnostics.js --write
```

The command prints a local JSON path under `~/.mossbridge/diagnostics/`.
By default it avoids raw text previews. If a specific symptom needs content-level inspection:

```bash
node scripts/collect-travel-diagnostics.js --write --include-previews
```

Use preview mode sparingly because it can include fragments of recent WeChat text.

## First Triage Questions

1. Did WeChat keep polling during the silent period?
2. Did inbound messages reach `accepted` and then `dispatched`?
3. Did the runtime start but fail to emit the first event, or did it finish but delivery fail?
4. Did system queues or deferred replies grow instead of drain?
5. Did runtime context approach the auto-compact threshold?
6. Did observation journal stay quiet for unrelated questions?
7. Did wakeups and reminders carry memory context or behave like empty alarms?
8. If dreaming was enabled for this pressure test, did it run while the user was quiet without relying on a private external scheduler?

## Expected Current Baseline

- Runtime: the selected `codex` or `claudecode` adapter for this smoke.
- Preferred model: the configured runtime default, or the workspace override shown by `/model`.
- Workspace root: the bound workspace used for this pressure test.
- Data root: the configured Mossbridge data root for this pressure test.
- Random check-in default: 5-25 minutes, with a recent-activity skip window.
- Observation journal: non-empty queries require observation intent or lexical activation; recency/confidence alone should not recall notes.

## After The Test

- Run the diagnostic script once before restarting anything.
- Save the printed diagnostic path in the follow-up conversation.
- Then run the script again after any restart or manual recovery.
- Compare the two snapshots before changing code.

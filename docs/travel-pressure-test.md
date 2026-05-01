# Travel Pressure Test Notes

This file is the handoff for the three-day WeChat/ClaudeCode bridge pressure test.
It is intentionally operational rather than architectural: when the user returns, collect evidence first, then decide what to fix.

## What To Preserve

- Keep the Mac awake, powered, and online when possible.
- Keep the shared bridge process running with ClaudeCode runtime.
- Do not clear `~/.asheriebridge` during the test.
- Do not delete `AsherieHome/data/cache` or `AsherieHome/data/storage`.
- If a failure appears in WeChat, note the local time and the user-facing symptom before retrying.

## Primary Signals

- `WeChat transport`: inbound accepted/dispatched, context token present, no repeated `ret=-2`.
- `ClaudeCode runtime`: first event latency, stall notices, quota/capacity notices, unexpected exits.
- `System queues`: system-message queue, deferred-system replies, reminders, and screenshot queue should not silently pile up.
- `Proactive check-in`: random check-ins should happen at the configured cadence, but skip recent active conversation.
- `Memory context`: ordinary turns should carry warm memory, ongoing tracks, observation journal only when activated, and recent-thread tail.
- `Dreaming/metabolism`: Home-side dreaming should see both WeChat and Home sediment when Home is running.
- `Cold tree`: do not treat lack of cold hits as failure by itself; evaluate whether topology edges and case/project provenance are useful.

## Quick Collection

From the Mossbridge repo:

```bash
node scripts/collect-travel-diagnostics.js --write
```

The command prints a local JSON path under `~/.asheriebridge/diagnostics/`.
By default it avoids raw text previews. If a specific symptom needs content-level inspection:

```bash
node scripts/collect-travel-diagnostics.js --write --include-previews
```

Use preview mode sparingly because it can include fragments of recent WeChat text.

## First Triage Questions

1. Did WeChat keep polling during the silent period?
2. Did inbound messages reach `accepted` and then `dispatched`?
3. Did ClaudeCode start but fail to emit the first event, or did it finish but delivery fail?
4. Did system queues or deferred replies grow instead of drain?
5. Did runtime context approach the auto-compact threshold?
6. Did observation journal stay quiet for unrelated questions?
7. Did wakeups and reminders carry memory context or behave like empty alarms?
8. Did dreaming run while Home was open and the user was quiet?

## Expected Current Baseline

- Runtime: ClaudeCode.
- Preferred model: `claude-opus-4-6`.
- Workspace root: `/Users/mac/Documents/Codex/1-Asherie`.
- Data root: `/Users/mac/Documents/Codex/AsherieHome/data`.
- Random check-in default: 5-25 minutes, with a recent-activity skip window.
- Observation journal: non-empty queries require observation intent or lexical activation; recency/confidence alone should not recall notes.

## After The Test

- Run the diagnostic script once before restarting anything.
- Save the printed diagnostic path in the follow-up conversation.
- Then run the script again after any restart or manual recovery.
- Compare the two snapshots before changing code.

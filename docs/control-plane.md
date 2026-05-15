# Mossbridge Control Plane

Mossbridge is not just a chat relay. It has autonomous bridge actions:
heartbeats, reminders, runtime cooldowns, deferred delivery, memory context
packets, and dreaming/metabolism passes. The control plane keeps those actions
readable without mixing them into the main assistant voice or the user memory
warehouse.

## Mental Model

Use the cybernetic loop:

```text
signal -> decision -> action -> feedback -> ledger
```

The bridge should be able to answer:

- What signal did Mossbridge observe?
- Which layer made the decision?
- What action did it take?
- Did it finish, skip, retry, or cool down?
- Was the visible text a bridge notice or a front-stage assistant reply?

## Code Boundary

- `src/control/`
  Owns control events, the local ledger, payload redaction, and small status
  summaries.
- `src/core/app.js`
  Emits control events from the main bridge loop.
- `src/app/system-checkin-poller.js`
  Emits control events for heartbeat schedule, skip, and queue decisions.
- `src/services/asherie-memory-service.js` and `src/asherie/`
  Remain the brain. They own memory layout and durable memory writes.
- runtime adapters
  Remain protocol engines. They should not own heartbeat or memory policy.

## Ledger Location

The ledger lives at:

```text
MOSSBRIDGE_STATE_DIR/control-events.jsonl
```

It is operational state. Do not commit it. Do not treat it as durable user
memory.

The ledger can store:

- event type, scope, layer, severity
- reason and outcome
- runtime/thread ids when useful
- counts and delivery reports
- sanitized error summaries

The ledger must not store:

- raw full prompts or private message bodies
- WeChat context tokens
- credentials, cookies, OAuth material, or account secrets
- hidden chain-of-thought
- stable personal memory facts unless they are already normal memory ids/counts

## Layers

- `observation`
  Something was seen: first-event delay, hot conversation, token pressure.
- `tactical`
  The bridge chose a policy: skip heartbeat, block on cooldown, trim memory
  delivery, request compact.
- `executive`
  The bridge did the thing: dispatch a runtime turn, defer delivery, write back,
  complete a dreaming attempt.
- `strategic`
  Reserved for future durable policy changes. First public Mossbridge should use
  this sparingly.

## Voice Boundary

Bridge status belongs to `[Mossbridge]` notices.

The soul-carrying assistant should receive a short identity/memory packet on
wakeups, but it should not be used as the narrator for quota, queue, runtime, or
delivery failures. If only a system report remains, the bridge reports it; if a
front-stage reply exists, the runtime speaks naturally.

## First-Version Scope

The current control plane records these paths:

- runtime turn dispatch, acceptance, pre-dispatch failure
- runtime quota/cooldown and blocked turns
- first-event and stalled-turn watchdog notices
- check-in interval backoff, skip, queue, and cooldown drop
- memory context packet delivery/skips
- runtime turn writeback success/failure
- dreaming queue, dispatch, completion, and retry-needed outcomes
- deferred channel replies

This is deliberately small. It makes the structure visible while keeping the
brain data stable and the runtime adapters clean.

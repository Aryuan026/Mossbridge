# Mossbridge Control Plane

This directory owns the cybernetic control surface for Mossbridge.

It is not a second brain and not a runtime adapter. It records why the bridge
made an automatic operational move:

- a system turn was queued, skipped, or dispatched
- a runtime entered cooldown or stalled
- a memory packet was delivered or skipped
- a dreaming/metabolism attempt was queued, completed, or retried
- a channel delivery was deferred or recovered

The control ledger belongs under `MOSSBRIDGE_STATE_DIR`, because it is
operational state. Durable user memory still belongs under
`MOSSBRIDGE_DATA_ROOT` and must go through the brain service boundary.

Use this layer to keep bridge behavior explainable without turning failure
notices into front-stage assistant speech.

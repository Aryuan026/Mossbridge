# Gateway-Shaped Architecture

This branch keeps Mossbridge as the single outward transport/runtime shell and
reshapes its internal service seams to match a memory-gateway mental model.

## Why this layer exists

The transport mouth should stay singular:

- one WeChat account
- one sync buffer owner
- one context token cache owner
- one active proactive delivery chain

The hard part is not "making Mossbridge become the gateway". The hard part is
stopping duplicated state while keeping the stronger chat/runtime shell.

## Public Product Boundary

Mossbridge's first public line is the user-facing conversation sedimentation bridge:

```text
WeChat conversation
  -> Mossbridge data root
  -> Codex or Claude Code runtime
  -> WeChat continuity surface
```

The expected dominant path is still OpenAI-user continuity, but the first
version does not wire automatic web AI capture sync or Notion sync. Codex helps
deploy and maintain the local bridge, and WeChat becomes a low-friction
continuation channel with the same local memory posture.

Mossbridge must not expose private external executor interfaces. If a simple
capability is needed for public use, it should be implemented as
Mossbridge-native bridge core or as a clearly optional adapter with its own
public config and permission boundary.

Private forks can keep private executor adapters where that is useful for live
pressure testing. Public Mossbridge should share data contracts and import
formats with that world, not inherit its private executor surface.

## Current block map

- `memory`
  - local implementation: `DiaryService`
  - explicit future seams: `captureContextPacket`, `writebackTurn`
- `appCapture`
  - deferred extension: browser/web capture importer
  - future target source: `chatgpt_web` daily capture into `cache/app_daily_captures/`
- `wakeup`
  - local implementation: `ReminderService`
  - local implementation: `SystemMessageService`
- `calendar`
  - local implementation: `TimelineService`
  - can later delegate reminder scheduling to gateway calendar rules
- `systemTurn`
  - local implementation: `SystemMessageService.queueMessage`
- `transport`
  - local implementation: `ChannelFileService`
- `presence`
  - local implementation: `WhereaboutsService`

## Portable Capability Triage

Reusable as Mossbridge-native behavior:

- local state/data layout, migration/import contracts, and empty-warehouse boot
- conversation cache, warm memory, ongoing tracks, observation, episode, solitude, and case index stores
- reminders, check-in queues, deferred replies, runtime cooldowns, and user-visible failure notices
- WeChat attachment intake, sticker catalog, file send, and timeline screenshot/file workflows
- read-only bridge status, safe self-check posture, diagnostics, and launchd/shared-start supervision
- web AI daily capture contracts and local import normalization, with automatic browser sync kept outside the first-version deploy path

Not portable into public Mossbridge:

- any private external executor that cannot be configured and audited as a Mossbridge-native adapter
- any side-effect gateway that can act outside Mossbridge's own state/data/workspace roots
- any tool hint that promises an unavailable external channel

## Practical migration rule

Replace the inside, not the mouth.

That means future gateway integration should swap block implementations behind
the `service-domains` layer instead of reintroducing a second WeChat polling and
send pipeline inside `mem0_gateway`.

The same rule applies to private-line behavior: port the small generic
capability into Mossbridge when it belongs to the public bridge, and keep private
account/device/permission executors outside the Mossbridge tool surface.

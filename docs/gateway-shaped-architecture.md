# Gateway-Shaped Architecture

This branch keeps `cyberboss` as the single outward transport/runtime shell and
reshapes its internal service seams to match the `mem0_gateway` mental model.

## Why this layer exists

The transport mouth should stay singular:

- one WeChat account
- one sync buffer owner
- one context token cache owner
- one active proactive delivery chain

The hard part is not "making Cyberboss become the gateway". The hard part is
stopping duplicated state while keeping the stronger chat/runtime shell.

## Current block map

- `memory`
  - local implementation: `DiaryService`
  - explicit future seams: `captureContextPacket`, `writebackTurn`
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

## Practical migration rule

Replace the inside, not the mouth.

That means future gateway integration should swap block implementations behind
the `service-domains` layer instead of reintroducing a second WeChat polling and
send pipeline inside `mem0_gateway`.

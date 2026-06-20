# Mossbridge Brain Boundary

This directory is a boundary marker for Mossbridge's built-in brain layer.

The current implementation still lives in historical modules such as:

- `src/asherie/`
- `src/services/asherie-memory-service.js`
- `src/asherie/storage-layout.js`

Do not move those modules casually. They hold the memory layout and recall
contracts that a public clone needs in order to run with its own data root.

## Boundary Rules

- Channel adapters are the mouth. They receive and send messages, then hand
  durable context to core.
- Runtime adapters are engines. They translate Codex or Claude Code protocol
  details and should not own memory policy.
- Tool and service domains are the hands. They may request memory actions
  through the memory service, but should not write brain files directly.
- `src/control/` is the control plane. It records operational decisions under
  `MOSSBRIDGE_STATE_DIR`; it must not promote bridge noise into memory.
- Brain code owns the data layout under `MOSSBRIDGE_DATA_ROOT`, context packets,
  hot context, warm memory diary/persona cards, cold-layer notebooks/journals,
  ongoing tracks, case index, source archives, and topology candidates.

If a mouth or hand change needs a new memory field, add it through the brain
service boundary with docs and tests. Fixing WeChat delivery should not rename
or reshuffle saved user memory.

## Current Human Routes

- Hot memory and active captures go to `cache/hot/`, `cache/conversation_cache/`,
  and `cache/app_daily_captures/`.
- Small notes and "小事记" go to `storage/notebook/`.
- Active unresolved threads go to `storage/ongoing_tracks.json`.
- Bounded stories, photo sessions, trips, and small events go to
  `storage/episode_journal/`.
- Work provenance, code fixes, deployment notes, artifacts, and test records go
  to `storage/case_index/`.
- Warm memory diary/persona cards go to `storage/warm_memory/`. They should read
  as first-person inner-view continuity for the soul/persona, not user profiles
  or generic fact summaries.
- Cold memory includes notebook, ongoing, observation, episode, case,
  `storage/raw_transcript_archive/`, `storage/memory_tree/`, and cold-root
  projections. Cold layers should preserve exact evidence and searchable
  structure.
- Immediate cross-window context and web AI capture merges stage through
  `cache/hot/` and `cache/conversation_cache/`, not directly into stable memory.

# Codex CLI Pressure-Test Handoff

Date: 2026-06-29

This handoff summarizes the public Mossbridge changes that came out of the Claude Code pressure-test line before the next pressure test shifts to Codex CLI as the runtime/LLM source.

It is not a production claim. Use it to separate implemented repository behavior, test-verified behavior, human QR/first-reply acceptance, and future pressure-test questions.

## Current Baseline

- Latest pushed code baseline before this handoff: `be657dc` (`Tighten foreground memory delivery`).
- Local repository already has a short deferred session-maintenance note in `AGENTS.md` and `docs/release-status.md`.
- The next pressure-test target is Codex CLI as the primary runtime path, not Claude Code.
- Deployment agents should read `docs/ai-deployment.md` first for shared-vs-runtime-specific parameter boundaries.
- Do not touch any private live service, private Home warehouse, real WeChat state, or old shared data root while validating public Mossbridge.

## What Landed In Public Mossbridge

### Public Onboarding And Safety

- README, quickstart, AI deployment, release status, and runtime-neutral docs now describe Mossbridge as **Public Preview / self-hosted alpha**, not Stable or Production Ready.
- Public defaults are safer:
  - passive foreground start by default;
  - check-in and dreaming require explicit opt-in;
  - empty allowlist is closed unless temporary enrollment is explicitly enabled;
  - `/tmp` paths are allowed only for disposable smoke checks, not persistent QR/service use.
- macOS launchd service install/start/restart refuses ephemeral state/data/workspace paths unless explicitly overridden for a disposable service smoke.
- `NOTICE.md`, AGPL/upstream Cyberboss attribution, GitHub Actions, `npm test`, and `npm run verify` are present.
- Empty local memory is a legal deploy state. No resident anchor, relationship seed, or private persona guess is required before the first user-confirmed conversation.

### Runtime Neutrality And Codex Support

- Codex and Claude Code are both treated as first-class runtime adapters.
- Codex runtime path supports model/provider configuration, model catalog metadata, native image input checks, provider-aware session store, and local provider wrapper template.
- Runtime model switching is exposed through shared bridge behavior where possible; runtime adapters keep protocol-specific details.
- Shared bridge code owns WeChat intake, memory packet construction, wakeups, notices, approval queues, and session-refresh requests.
- Adapter-specific code should stay limited to RPC/process shape, session ids, auth state, model parameters, native image serialization, and approval protocol differences.

### Built-In Brain And Storage Boundary

- Mossbridge is not an empty mouth that requires a private Home service.
- The public repo carries a local brain under `MOSSBRIDGE_DATA_ROOT`: hot context, conversation cache, notebook, warm memory, ongoing tracks, observation journal, episode journal, case index, cold-root compatibility, source events, and mutation ledgers.
- The code boundary is explicit:
  - mouth: WeChat adapter;
  - engines: Codex and Claude Code adapters;
  - hands: tools and non-memory services;
  - brain: `src/asherie/` and `src/services/asherie-memory-service.js`;
  - control plane: operational state and why decisions happened.
- Future ChatGPT/web/app captures should stage into cache/source-event lanes first, not write raw captures directly into warm/cold/case memory.

### Memory Write And Metabolism Contracts

- Dreaming/metabolism moved toward an auditable protocol:
  - append-only source events;
  - stable source ids and content hashes;
  - server-generated mutation ledger;
  - per-source dispositions;
  - source status instead of batch no-op swallowing;
  - source ownership validation;
  - retry/deferred/conflict lanes;
  - retrieval no longer self-strengthens a warm card just because it was retrieved.
- Warm-card writing guidance now emphasizes first-person inner-view diary/persona memory, source traceability, and future usefulness.
- Cold memory, notebook, observation, episode, and case lanes are kept distinct from warm diary cards.
- Known unfinished durability gap: full write-ahead/orphan mutation recovery is still not complete. Store mutation success followed by ledger persistence failure remains a future hardening item.

### Foreground Guidance And Voice Hygiene

- Maintenance/self-management guidance was moved out of ordinary foreground user turns.
- Ordinary WeChat foreground turns should receive relevant memory/hot-context material, not the full operations manual about risk tiers, self-maintenance, resident layers, or evidence gaps.
- System maintenance, dreaming, and non-lite background turns may still receive maintenance guidance when appropriate.
- Bridge/system notices were made more neutral and clearly bridge-shaped, so status messages do not sound like the main assistant speaking with its soul/persona.
- Public prompt guidance removed user diagnosis assumptions and should avoid locking a user's gender, condition, relationship, or identity from system text.
- Tool and runtime guidance should not restrict the front-stage model's expressive voice. Memory provides material; permissions and safety live in code/tool boundaries.

### Memory Delivery And Context Budget

- Ordinary foreground turns now preserve resident/ambient continuity without expanding every turn into a large memory packet.
- Warm, ongoing, episode, observation, and cold/archive material should be relevance-gated, budget-gated, and evidence-driven.
- Self-axis and dreaming material should not enter ordinary foreground by default.
- Session lifecycle continuity is control-plane by default and should not inflate the ordinary memory package or inject raw recent tail. Explicit user requests to continue or quote recent context keep a small bounded recent-thread recall path.
- Delivery reports include actual final runtime prompt length estimates, not only hit counts or cache-token guesses.
- Current optimization principle: do not use "larger memory packet every turn" to compensate for poor recall precision.

### Session And Runtime Maintenance

- Existing public code can queue session refresh under pressure and apply it on the next normal foreground user turn rather than abruptly cutting a background turn.
- Several private-test stability fixes were absorbed around slow replies, runtime notices, Claude Code thread cleanup, pending approval ordering, and post-refresh continuity.
- The next strategy review should not reduce session maintenance to one threshold rule.
- Pending principle for future work:
  - compression keeps a session alive;
  - session switching is ventilation;
  - healthy natural chat may continue or observe runtime/CLI compression;
  - case/code/attachment pollution should checkpoint or handoff before switching;
  - slow replies, tool errors, stiff posture, or wrong-context pollution can justify a recovery switch.

## What Is Verified Versus Still Unclaimed

### Verified By Repository Tests / CI

- Syntax and unit/integration tests run through `npm run verify`.
- Public onboarding hardening has tests for allowlist, open inbound/enrollment, and ephemeral service path refusal.
- Memory metabolism contract tests cover many receipt, ledger, source status, and retry edge cases.
- Foreground maintenance-guidance leakage is covered by tests.
- Foreground memory delivery tightening is covered by focused tests.

### Not Yet Claimed As Human-Verified

- Clean public tester account QR login.
- First WeChat reply from a clean account and persistent public data root.
- Long-running Codex CLI pressure behavior.
- Codex native image input in a real WeChat attachment flow.
- Multi-day check-in/dreaming behavior under Codex CLI.
- Full write-ahead/orphan mutation recovery under crash or disk-error conditions.
- Automatic browser/chat capture synchronization.
- Notion synchronization.

### Private Pressure-Test Evidence Only

Claude Code pressure testing produced many useful failure shapes, but those results are not automatically Codex CLI results. Treat them as design input, not proof of Codex behavior.

## Next Codex CLI Pressure-Test Plan

### 1. Clean Persistent Deployment Smoke

- Use a clean clone or clean working tree.
- Use persistent operator-chosen state/data/workspace paths, not `/tmp`, before QR login or service install.
- Run `npm ci`, `npm run doctor`, `npm run smoke:memory-empty`, `npm run smoke:memory-chain`, and `npm run verify`.
- Start passively first. Do not enable check-in or dreaming until the normal foreground path is proven.
- Use `MOSSBRIDGE_ALLOWED_USER_IDS` after identifying the sender id from QR login, `npm run accounts`, or a deliberate temporary enrollment window.

### 2. Codex Foreground Conversation

Observe:

- first event latency;
- runtime notice wording;
- ordinary reply continuity;
- whether resident/ambient context is enough for a comfortable first day;
- whether warm/ongoing/episode/observation material only appears when topic-relevant;
- actual `runtime_prompt_chars` and estimated prompt tokens in delivery diagnostics.

Do not tune memory recall from a single false-positive example. Collect query, delivered item, lane/source, whether it helped, and expected behavior.

### 3. Session Health And Handoff

Observe:

- context usage snapshots from Codex CLI;
- whether native CLI compression occurs before Mossbridge forces a refresh;
- whether session refresh is triggered by real state quality or only token percentage;
- whether control-plane continuity plus explicit bounded recent recall preserves continuity without rebuilding too much prompt every turn;
- whether post-refresh voice and relationship continuity survive.

If this area needs code work, add strategy/reason records first: `continue`, `observe_compression`, `checkpoint_then_switch`, or `recovery_switch`.

### 4. Tooling And Approval Flow

Verify:

- `/model`, `/status`, `/bind`, and model catalog behavior;
- pending approvals are ordered and do not deadlock;
- tool errors become bridge/runtime diagnostics, not durable memory;
- foreground assistant expression is not constrained by tool safety text;
- bridge notices are clearly `[Mossbridge]` layer messages.

### 5. Attachments, Stickers, And Native Image Input

Verify:

- WeChat images save to the public data/workspace boundary;
- Codex native image-capable models receive saved images as local image inputs when configured;
- fallback text remains usable when native image input is disabled;
- stickers and media failures are visible and throttled without becoming assistant memory.

### 6. Opt-In Check-In And Dreaming

Enable only after foreground Codex works.

Observe:

- random check-ins skip active chat and do not wake empty;
- system turns carry a short wake anchor and scoped memory, not the full opening prompt;
- dreaming attempts consume auditable source events and require receipts;
- failed/deferred sources stay retryable rather than disappearing.

## Optimization Boundaries For The Next Pass

- Do not enlarge every memory packet to mask recall precision problems.
- Do not put maintenance manuals back into ordinary foreground turns.
- Do not restrict the front-stage model's tone, warmth, preference, humor, or intimacy through memory or tool instructions.
- Do not treat token percentage alone as a mandatory session-cut trigger.
- Do not couple public Mossbridge back to private Home or private account/device tools.
- Do not claim clean-account QR, first reply, long-run Codex stability, browser capture, Notion sync, or crash-safe mutation recovery until actually tested.

## Recent Commit Trail Used For This Summary

Use this trail as a map, not as a substitute for reading diffs before changing code.

### Public Core / Onboarding

- `69f775e` Prepare public runtime-neutral Mossbridge core
- `e94d0d4` Define built-in brain boundary
- `60d1c7e` Add human-readable architecture guide
- `0adf9e4` Harden public deployment entrypoints
- `8df3f7c` Harden public onboarding safety

### Runtime Stability / Session / Approvals

- `d7ea2b4` asherie: sync session refresh pressure guardrails
- `17b420f` asherie: queue runtime approvals in order
- `68edec9` asherie: absorb upstream claudecode delivery safeguards
- `7759561` asherie: prioritize session refresh under pressure
- `989c356` asherie: silence background claudecode watchdog notices
- `9451a15` asherie: clean idle claudecode system threads
- `7cfa3c0` asherie: absorb bridge runtime bug fixes
- `7c8cf7e` asherie: smooth auto session refresh handoff
- `47184ac` asherie: carry ambient warm through session handoff
- `b8dc786` asherie: stabilize post-refresh continuity
- `206ecfc` asherie: harden codex rpc child lifecycle

### Foreground Voice / Guidance / Public Neutrality

- `4cab4b6` asherie: sync attachment and sticker delivery fixes
- `4724424` asherie: refine wechat prompts and session handoff
- `503276f` asherie: sync memory delivery gating fixes
- `b342f87` asherie: soften public prompt guidance
- `224e4b1` asherie: sync clean prompt agency fixes
- `359cd25` asherie: remove public user diagnosis assumptions
- `0a39e70` asherie: make bridge notices neutral
- `da29829` asherie: clarify frontstage memory guidance test
- `7ba0146` asherie: keep maintenance guidance backstage

### Memory Delivery / Continuity

- `2c504fc` asherie: harden public memory and delivery loops
- `4d4b7a1` asherie: tune memory delivery for public deploy
- `c664dcb` asherie: sync playful memory delivery profile
- `8528f21` asherie: allow evidence-based assistant preferences
- `b830922` asherie: tune case recall and task tone
- `e1dfcac` asherie: tune memory delivery probes
- `0fb7cd8` asherie: reduce memory delivery noise
- `86d5111` asherie: preserve hot session continuity
- `be657dc` Tighten foreground memory delivery

### Memory Metabolism / Source Integrity

- `37f5a46` Clarify warm memory source backfill contract
- `e3d15c7` Harden memory metabolism protocol
- `f2b7f34` Harden memory write and metabolism contracts
- `aa80a9c` Tighten memory metabolism edge cases

## Where Future Fixes Should Go

- Runtime-neutral behavior: shared bridge core.
- Codex protocol details: `src/adapters/runtime/codex/`.
- Claude Code protocol details: `src/adapters/runtime/claudecode/`.
- Memory storage/metabolism: brain service/store boundary, not WeChat mouth code.
- User-visible status text: bridge notices, not front-stage assistant memory.
- Public deployment instructions: `README.md`, `docs/quickstart.md`, and `docs/ai-deployment.md`.
- Operational pressure-test notes: `docs/travel-pressure-test.md`.

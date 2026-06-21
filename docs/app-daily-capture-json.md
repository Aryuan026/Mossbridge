# Web AI Daily Capture JSON Contract

Status: source-neutral capture contract plus local importer.

This contract is for tools that export web AI conversations into Mossbridge. ChatGPT web is one source, but the same shape can carry Claude web, Gemini, Perplexity, Rikkahub, or another browser AI frontend. It is an interchange format first; the importer then stages it into Mossbridge cache and hot context.

The capture tool should only export raw conversation data. It must not call private external executors, assume third-party account access, or write directly to stable memory.

## Bundle Shape

Use one JSON file per export batch:

```json
{
  "schema": "mossbridge_app_daily_capture_bundle_v0.1",
  "source_client": "chatgpt_web",
  "captured_date": "2026-05-10",
  "captured_at": "2026-05-10T15:30:00.000Z",
  "timezone": "Asia/Shanghai",
  "exporter": {
    "name": "chatgpt-capture",
    "version": "0.1.0"
  },
  "conversations": [
    {
      "conversation_id": "source-thread-id",
      "conversation_title": "A short title",
      "source_url": "https://chatgpt.com/c/example",
      "messages": [
        {
          "message_id": "msg-1",
          "role": "user",
          "text": "hello",
          "created_at": "2026-05-10T08:30:00.000Z",
          "local_date": "2026-05-10",
          "attachments": []
        }
      ]
    }
  ]
}
```

Required top-level fields:

- `schema`: `mossbridge_app_daily_capture_bundle_v0.1`
- `source_client`: for example `chatgpt_web`, `claude_web`, `gemini_web`, `perplexity_web`, `rikkahub`, or `web_ai_window`
- `captured_date`: local `YYYY-MM-DD`
- `captured_at`: ISO timestamp
- `conversations`: array

Required conversation fields:

- `conversation_id`
- `messages`

Required message fields:

- `role`
- `created_at`
- either `text` or at least one `attachments` item

Accepted message roles are `user`, `assistant`, `system`, `developer`, `tool`, and `unknown`.

`message_id` is recommended. If the upstream source cannot provide one, the future importer can derive a stable id from conversation id, timestamp, role, and text hash.

## Canonical Staging Layout

After validation, a local staging step may place the capture under the Mossbridge data root:

```text
MOSSBRIDGE_DATA_ROOT/
  cache/
    app_daily_captures/
      chatgpt_web/
        2026-05-10/
          manifest.json
          conversations.jsonl
          attachments.jsonl
```

The directory layout is the local staging shape. The single-file bundle is the recommended interchange shape for browser extensions and external exporters.

## Validation

Validate a single-file bundle:

```bash
npm run capture:validate -- /path/to/capture-bundle.json
```

Validate a staged directory:

```bash
npm run capture:validate -- "$MOSSBRIDGE_DATA_ROOT/cache/app_daily_captures/chatgpt_web/2026-05-10"
```

The validator is read-only. It does not write conversation cache, warm memory, cold memory, episode journals, or case indexes.

## Import

Import writes only to the configured Mossbridge data root. It requires explicit `MOSSBRIDGE_STATE_DIR` and `MOSSBRIDGE_DATA_ROOT` so a test import cannot silently land in a private live memory warehouse.

```bash
MOSSBRIDGE_STATE_DIR=/tmp/mossbridge-capture/state \
MOSSBRIDGE_DATA_ROOT=/tmp/mossbridge-capture/data \
npm run capture:import -- /path/to/capture-bundle.json
```

The importer:

- stages the bundle under `cache/app_daily_captures/<source_client>/<captured_date>/`
- writes stable, deduplicated turn pairs into `cache/conversation_cache/`
- writes recent source packets into `cache/hot/upstream_context_merge/`
- writes recent turn slices and a projection into `cache/hot/context_basin/` and `cache/hot/projections/`
- writes append-only source events into `storage/memory_metabolism_source_events/` so later dreaming can evaluate old captures without relying only on a recent-time cursor

It does not promote anything directly into warm cards, cold roots, notebooks, episodes, or cases. Those stable layers are still owned by normal memory tools and dreaming/metabolism passes.

## Sedimentation Path

The intended flow is:

```text
capture bundle
  -> validate
  -> stage under cache/app_daily_captures
  -> normalize into cache/conversation_cache, cache/hot, and metabolism source events
  -> local review/dreaming extracts notebook, warm, ongoing, episode, and case candidates
  -> accepted stable memory is written by tools with a server mutation ledger
  -> receipt closes each source as promoted, evaluated, rejected, deferred, conflict, or retryable failure
```

Daily captures are raw source material. They should stay auditable and reversible.

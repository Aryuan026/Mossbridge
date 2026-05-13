# App Daily Capture JSON Contract

Status: deferred extension note. ChatGPT web/app capture is not part of the first public Mossbridge deployment path; this file only preserves the future interchange contract.

This contract is for tools that export ChatGPT web/app conversations into Mossbridge. It is an interchange format, not a memory-store format.

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
      "conversation_id": "chatgpt-thread-id",
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
- `source_client`: for example `chatgpt_web`, `chatgpt_app`, or another local capture source
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

## Sedimentation Path

The intended flow is:

```text
capture bundle
  -> validate
  -> stage under cache/app_daily_captures
  -> normalize into cache/conversation_cache
  -> local review/dreaming extracts warm, ongoing, episode, and case candidates
  -> accepted stable memory is written to storage
```

Daily captures are raw source material. They should stay auditable and reversible.

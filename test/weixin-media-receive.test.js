const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { finalizeAttachmentNotes } = require("../src/adapters/channel/weixin/media-receive");

test("finalizeAttachmentNotes fills pending attachment note from same-turn assistant reply", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-attachment-note-"));
  const notePath = path.join(tmpDir, "attachment.md");
  fs.writeFileSync(notePath, [
    "# Attachment Note",
    "",
    "- received_at: 2026-04-28T12:48:14.321Z",
    "- kind: image",
    "- saved_file: wechat/inbox/2026-04-28/attachment.jpg",
    "",
    "## Summary",
    "<pending>",
    "",
    "## Why It May Matter",
    "<pending>",
    "",
    "## Visible Text / Details",
    "<pending>",
    "",
    "## Follow-up",
    "<pending>",
    "",
  ].join("\n"), "utf8");

  const result = await finalizeAttachmentNotes({
    attachments: [{
      kind: "image",
      relativePath: "wechat/inbox/2026-04-28/attachment.jpg",
      noteAbsolutePath: notePath,
    }],
    assistantTextFinal: "这张图显示 ATM-Bench-Hard 上你的系统 R@10 是 28.9%，高于 HippoRAG2 的 17.6%。\n\n后续瓶颈更像是 recall@100 和 query 理解。",
    writebackResult: {
      appended_record: {
        record_id: "cap_dcd4b3c3a023471c",
        path: "/memory/conversation_cache/owner.jsonl",
      },
    },
    completedAt: "2026-04-28T12:50:38.698Z",
  });

  const updated = fs.readFileSync(notePath, "utf8");
  assert.deepEqual(result, { updated: 1, skipped: 0 });
  assert.match(updated, /Auto-captured from the assistant reply/i);
  assert.match(updated, /28\.9%/);
  assert.match(updated, /HippoRAG2/);
  assert.match(updated, /conversation_cache_record: cap_dcd4b3c3a023471c/);
  assert.doesNotMatch(updated, /<pending>/);
});

test("finalizeAttachmentNotes does not overwrite manually edited note sections", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-attachment-note-"));
  const notePath = path.join(tmpDir, "attachment.md");
  fs.writeFileSync(notePath, [
    "# Attachment Note",
    "",
    "## Summary",
    "Manual summary stays.",
    "",
    "## Visible Text / Details",
    "<pending>",
    "",
  ].join("\n"), "utf8");

  await finalizeAttachmentNotes({
    attachments: [{ noteAbsolutePath: notePath }],
    assistantTextFinal: "Auto explanation.",
  });

  const updated = fs.readFileSync(notePath, "utf8");
  assert.match(updated, /Manual summary stays\./);
  assert.match(updated, /Auto explanation\./);
});

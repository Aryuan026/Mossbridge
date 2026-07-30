const test = require("node:test");
const assert = require("node:assert/strict");

const { buildHotContextPreludeLines } = require("../src/asherie/hot-context-store");

test("hot context prelude keeps upstream capture structured by default", () => {
  const lines = buildHotContextPreludeLines({
    query: "deployment checklist",
    projection: {
      summary: "web_ai_capture from perplexity_web | user: 继续整理 Mossbridge deployment checklist / assistant: 先检查 isolated state/data，再跑 capture import。",
      open_loops: ["deployment thread: 继续整理 Mossbridge deployment checklist"],
    },
    basin: {
      head: {
        open_loops: ["deployment thread: 继续整理 Mossbridge deployment checklist"],
      },
    },
    upstream: {
      packages: [
        {
          source_client: "perplexity_web",
          thread_title: "deployment thread",
          summary: "deployment thread | user: 继续整理 Mossbridge deployment checklist / assistant: 先检查 isolated state/data，再跑 capture import。",
          recent_messages: [
            { role: "user", content: "继续整理 Mossbridge deployment checklist" },
            { role: "assistant", content: "先检查 isolated state/data，再跑 capture import。" },
          ],
        },
      ],
    },
  }, 4);

  const joined = lines.join("\n");
  assert.match(joined, /hot-projection: web_ai_capture from perplexity_web/);
  assert.match(joined, /hot-open-loop: pending=1/);
  assert.match(joined, /hot-source: perplexity_web \| deployment thread \| recent_messages=2/);
  assert.doesNotMatch(joined, /继续整理 Mossbridge deployment checklist/);
  assert.doesNotMatch(joined, /先检查 isolated state\/data，再跑 capture import/);
});

test("hot context prelude includes raw upstream wording only when explicitly requested", () => {
  const lines = buildHotContextPreludeLines({
    query: "把 deployment checklist 那段原话 quote 给我",
    projection: {
      summary: "web_ai_capture from perplexity_web | user: 继续整理 Mossbridge deployment checklist / assistant: 先检查 isolated state/data，再跑 capture import。",
      open_loops: ["deployment thread: 继续整理 Mossbridge deployment checklist"],
    },
    basin: {
      head: {
        open_loops: ["deployment thread: 继续整理 Mossbridge deployment checklist"],
      },
    },
    upstream: {
      packages: [
        {
          source_client: "perplexity_web",
          thread_title: "deployment thread",
          summary: "deployment thread | user: 继续整理 Mossbridge deployment checklist / assistant: 先检查 isolated state/data，再跑 capture import。",
          recent_messages: [
            { role: "user", content: "继续整理 Mossbridge deployment checklist" },
            { role: "assistant", content: "先检查 isolated state/data，再跑 capture import。" },
          ],
        },
      ],
    },
  }, 4);

  const joined = lines.join("\n");
  assert.match(joined, /hot-open-loop: deployment thread: 继续整理 Mossbridge deployment checklist/);
  assert.match(joined, /user: 继续整理 Mossbridge deployment checklist/);
  assert.match(joined, /assistant: 先检查 isolated state\/data，再跑 capture import。/);
});

test("hot context prelude keeps basin recent turns structured unless explicit wording is requested", () => {
  const packet = {
    query: "最近跨窗口都在忙什么",
    upstream: { packages: [] },
    basin: {
      head: {},
      recent_turns: [
        {
          source_client: "perplexity_web",
          thread_id: "thread-1",
          role: "user",
          content: "继续整理 Mossbridge deployment checklist",
          attachment_count: 1,
        },
      ],
    },
  };

  const ordinary = buildHotContextPreludeLines(packet, 4).join("\n");
  assert.match(ordinary, /hot-turn: perplexity_web \| role=user \| thread=thread-1 \| attachments=1/);
  assert.doesNotMatch(ordinary, /继续整理 Mossbridge deployment checklist/);

  const explicit = buildHotContextPreludeLines({
    ...packet,
    query: "把刚才那句原话引用出来",
  }, 4).join("\n");
  assert.match(explicit, /hot-turn: perplexity_web \| user: 继续整理 Mossbridge deployment checklist/);
});

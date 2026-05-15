const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { CodexRpcClient } = require("../src/adapters/runtime/codex/rpc-client");

test("codex rpc client uses turn/interrupt for stop requests", async () => {
  const client = new CodexRpcClient({ endpoint: "ws://127.0.0.1:8765" });
  const calls = [];
  client.sendRequest = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };

  await client.cancelTurn({
    threadId: "thread-1",
    turnId: "turn-1",
  });

  assert.deepEqual(calls, [{
    method: "turn/interrupt",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
    },
  }]);
});

test("codex rpc client sends image attachments as local images", async () => {
  const client = new CodexRpcClient({ endpoint: "ws://127.0.0.1:8765" });
  const calls = [];
  client.sendRequest = async (method, params) => {
    calls.push({ method, params });
    return { result: { turn: { id: "turn-1" } } };
  };

  await client.sendUserMessage({
    threadId: "thread-1",
    text: "what is this image?",
    attachments: [{
      absolutePath: path.join("/tmp", "mossbridge image.jpg"),
      contentType: "image/jpeg",
    }],
  });

  assert.equal(calls[0].method, "turn/start");
  assert.deepEqual(calls[0].params.input, [
    { type: "text", text: "what is this image?" },
    {
      type: "localImage",
      path: "/tmp/mossbridge image.jpg",
    },
  ]);
});

test("codex rpc client includes model provider on thread start, resume, and turn start", async () => {
  const client = new CodexRpcClient({ endpoint: "ws://127.0.0.1:8765" });
  const calls = [];
  client.sendRequest = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };

  await client.startThread({
    cwd: "/workspace",
    model: "gemma4:26b",
    modelProvider: "ollama",
  });
  await client.resumeThread({
    threadId: "thread-1",
    model: "gemma4:26b",
    modelProvider: "ollama",
  });
  await client.sendUserMessage({
    threadId: "thread-1",
    text: "hello",
    model: "gemma4:26b",
    modelProvider: "ollama",
  });
  await client.sendUserMessage({
    text: "opening",
    model: "gemma4:26b",
    modelProvider: "ollama",
  });

  assert.deepEqual(calls.map((item) => item.method), [
    "thread/start",
    "thread/resume",
    "turn/start",
    "thread/start",
  ]);
  assert.equal(calls[0].params.model, "gemma4:26b");
  assert.equal(calls[0].params.modelProvider, "ollama");
  assert.equal(calls[1].params.model, "gemma4:26b");
  assert.equal(calls[1].params.modelProvider, "ollama");
  assert.equal(calls[2].params.model, "gemma4:26b");
  assert.equal(calls[2].params.modelProvider, "ollama");
  assert.equal(calls[3].params.model, "gemma4:26b");
  assert.equal(calls[3].params.modelProvider, "ollama");
  assert.deepEqual(calls[3].params.input, [{ type: "text", text: "opening" }]);
});

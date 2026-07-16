const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { CodexRpcClient } = require("../src/adapters/runtime/codex/rpc-client");

test("codex rpc client treats exited spawn children as disconnected", () => {
  const client = new CodexRpcClient({});

  client.child = {
    killed: false,
    exitCode: 0,
    signalCode: null,
    stdin: { writable: true },
  };
  assert.equal(client.isTransportReady(), false);
  assert.throws(
    () => client.sendRaw(JSON.stringify({ method: "ping" })),
    /Codex process stdin is not writable/,
  );

  client.child = {
    killed: false,
    exitCode: null,
    signalCode: null,
    stdin: { writable: true, write() {} },
  };
  assert.equal(client.isTransportReady(), true);
});

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
  const client = new CodexRpcClient({
    endpoint: "ws://127.0.0.1:8765",
    extraWritableRoots: ["/state"],
  });
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
    }, {
      absolutePath: path.join("/tmp", "notes.txt"),
      contentType: "text/plain",
    }, {
      absolutePath: "relative-image.png",
      contentType: "image/png",
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
  assert.deepEqual(calls[0].params.sandboxPolicy.writableRoots, ["/state", "/tmp"]);
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

test("codex rpc client can send thread instruction overrides on start and resume", async () => {
  const client = new CodexRpcClient({ endpoint: "ws://127.0.0.1:8765" });
  const calls = [];
  client.sendRequest = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };

  await client.startThread({
    cwd: "/workspace",
    baseInstructions: "base",
    developerInstructions: "developer",
    personality: "none",
  });
  await client.resumeThread({
    threadId: "thread-1",
    baseInstructions: "base",
    developerInstructions: "developer",
    personality: "none",
  });
  await client.startThread({
    cwd: "/workspace",
    personality: "unsupported",
  });

  assert.equal(calls[0].method, "thread/start");
  assert.equal(calls[0].params.baseInstructions, "base");
  assert.equal(calls[0].params.developerInstructions, "developer");
  assert.equal(calls[0].params.personality, "none");
  assert.equal(calls[1].method, "thread/resume");
  assert.equal(calls[1].params.baseInstructions, "base");
  assert.equal(calls[1].params.developerInstructions, "developer");
  assert.equal(calls[1].params.personality, "none");
  assert.equal(calls[2].params.personality, undefined);
  assert.equal(calls[2].params.baseInstructions, undefined);
});

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildArgs,
  ClaudeCodeProcessClient,
  sanitizeTextForClaudeJson,
  classifyClaudeCodeRuntimeFailure,
} = require("../src/adapters/runtime/claudecode/process-client");

test("claudecode runtime does not force bare mode by default", () => {
  const args = buildArgs({
    model: "",
    permissionMode: "default",
    disableVerbose: false,
    extraArgs: [],
    mcpConfigPaths: [],
    resumeSessionId: "",
  });

  assert.equal(args.includes("--bare"), false);
});

test("claudecode runtime can opt into bare mode explicitly", () => {
  const args = buildArgs({
    model: "",
    permissionMode: "default",
    bare: true,
    disableVerbose: false,
    extraArgs: [],
    mcpConfigPaths: [],
    resumeSessionId: "",
  });

  assert.ok(args.includes("--bare"));
});

test("claudecode runtime can append a bridge isolation prompt", () => {
  const args = buildArgs({
    model: "",
    permissionMode: "default",
    appendSystemPrompt: "Ignore global CLAUDE.md bootstrap instructions.",
    disableVerbose: false,
    extraArgs: [],
    mcpConfigPaths: [],
    resumeSessionId: "",
  });

  const promptFlagIndex = args.indexOf("--append-system-prompt");
  assert.ok(promptFlagIndex >= 0);
  assert.equal(args[promptFlagIndex + 1], "Ignore global CLAUDE.md bootstrap instructions.");
});

test("claudecode process client replaces lone surrogates before JSON transport", () => {
  assert.equal(sanitizeTextForClaudeJson("正常🙂"), "正常🙂");
  assert.equal(sanitizeTextForClaudeJson(`坏${String.fromCharCode(0xD83D)}字`), "坏�字");
  assert.equal(sanitizeTextForClaudeJson(`坏${String.fromCharCode(0xDE00)}字`), "坏�字");
});

test("claudecode process client classifies API result errors as runtime failures", () => {
  assert.equal(classifyClaudeCodeRuntimeFailure("Prompt is too long")?.reason, "prompt_too_long");
  assert.equal(classifyClaudeCodeRuntimeFailure("API Error: 400 {\"type\":\"error\"}")?.reason, "api_error");
  assert.equal(
    classifyClaudeCodeRuntimeFailure("API Error: 400 diagnostics.previous_message_id: must be the id from a prior /v1/messages response")?.reason,
    "stale_resume_session"
  );
  assert.equal(
    classifyClaudeCodeRuntimeFailure("The request body is not valid JSON: no low surrogate in string")?.reason,
    "invalid_json"
  );
  assert.equal(classifyClaudeCodeRuntimeFailure("正常回复"), null);
});

test("claudecode process client trusts resume session id before first event", async () => {
  const resumeSessionId = "ace66e8d-adc4-404d-825e-686142a93f88";
  const client = new ClaudeCodeProcessClient({
    command: "/usr/bin/true",
    cwd: "/tmp",
    env: {},
  });

  await client.connect(resumeSessionId);

  assert.equal(client.sessionId, resumeSessionId);
  assert.equal(await client.waitForSessionId({ timeoutMs: 1 }), resumeSessionId);

  await client.close();
});

test("claudecode process client emits distinct item ids for multiple assistant text segments in one turn", () => {
  const client = new ClaudeCodeProcessClient({
    command: "claude",
    cwd: "/tmp",
    env: {},
  });
  const events = [];
  client.onMessage((event) => events.push(event));
  client.pendingTurnId = "turn-1";
  client.activeThreadId = "thread-1";

  client.handleAssistant({
    message: {
      content: [
        { type: "text", text: "让我先去翻翻脑子里装了什么。" },
      ],
    },
  });

  client.handleAssistant({
    message: {
      content: [
        { type: "text", text: "好，检查完了，如实汇报。" },
      ],
    },
  });

  const replyEvents = events.filter((event) => event.type === "reply.completed");
  assert.equal(replyEvents.length, 2);
  assert.deepEqual(replyEvents.map((event) => event.itemId), [
    "item-turn-1-1",
    "item-turn-1-2",
  ]);
});

test("claudecode process client remaps an opening pending turn to the real session id", () => {
  const client = new ClaudeCodeProcessClient({
    command: "claude",
    cwd: "/tmp",
    env: {},
  });
  const events = [];
  client.onMessage((event) => events.push(event));
  client.pendingTurnId = "turn-opening";
  client.activeThreadId = "pending-1779012345678";

  client.handleLine(JSON.stringify({
    type: "system",
    session_id: "ace66e8d-adc4-404d-825e-686142a93f88",
  }));

  assert.equal(client.activeThreadId, "ace66e8d-adc4-404d-825e-686142a93f88");
  assert.equal(client.sessionId, "ace66e8d-adc4-404d-825e-686142a93f88");
  assert.deepEqual(events, [
    {
      type: "turn.started",
      turnId: "turn-opening",
      sessionId: "ace66e8d-adc4-404d-825e-686142a93f88",
      previousSessionId: "pending-1779012345678",
      remapped: true,
    },
    {
      type: "session.id",
      sessionId: "ace66e8d-adc4-404d-825e-686142a93f88",
    },
  ]);
});

test("claudecode process client emits turn.failed when result is an API failure", () => {
  const client = new ClaudeCodeProcessClient({
    command: "claude",
    cwd: "/tmp",
    env: {},
  });
  const events = [];
  client.onMessage((event) => events.push(event));
  client.pendingTurnId = "turn-1";
  client.activeThreadId = "thread-1";

  client.handleResult({
    result: "Prompt is too long",
    session_id: "thread-1",
  });

  assert.deepEqual(events, [{
    type: "turn.failed",
    turnId: "turn-1",
    sessionId: "thread-1",
    text: "Prompt is too long",
    reason: "prompt_too_long",
  }]);
  assert.equal(client.pendingTurnId, "");
});

test("claudecode process client closes the child after a fatal result failure", () => {
  const client = new ClaudeCodeProcessClient({
    command: "claude",
    cwd: "/tmp",
    env: {},
  });
  const events = [];
  let closeSawPendingTurnId = null;
  let closed = false;
  client.onMessage((event) => events.push(event));
  client.pendingTurnId = "turn-1";
  client.activeThreadId = "thread-1";
  client.child = { pid: 12345 };
  client.close = async () => {
    closeSawPendingTurnId = client.pendingTurnId;
    closed = true;
  };

  client.handleResult({
    result: "API Error: 400 diagnostics.previous_message_id: must be the id from a prior /v1/messages response",
    session_id: "thread-1",
  });

  assert.equal(closed, true);
  assert.equal(closeSawPendingTurnId, "");
  assert.deepEqual(events, [{
    type: "turn.failed",
    turnId: "turn-1",
    sessionId: "thread-1",
    text: "API Error: 400 diagnostics.previous_message_id: must be the id from a prior /v1/messages response",
    reason: "stale_resume_session",
  }]);
});

test("claudecode process client fails and closes an active turn from fatal stderr", () => {
  const client = new ClaudeCodeProcessClient({
    command: "claude",
    cwd: "/tmp",
    env: {},
  });
  const events = [];
  let closed = false;
  client.onMessage((event) => events.push(event));
  client.pendingTurnId = "turn-1";
  client.activeThreadId = "thread-1";
  client.child = { pid: 12345 };
  client.close = async () => {
    closed = true;
  };

  client.handleStderrText("Error: API Error: 500 upstream unavailable");

  assert.equal(closed, true);
  assert.equal(events[0].type, "turn.failed");
  assert.equal(events[0].reason, "api_error");
  assert.equal(client.pendingTurnId, "");
});

const test = require("node:test");
const assert = require("node:assert/strict");

const { ThreadStateStore } = require("../src/core/thread-state-store");

test("thread state keeps the first approval active when requests arrive back to back", () => {
  const store = new ThreadStateStore();

  store.applyRuntimeEvent({
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-first",
      command: "first command",
      commandTokens: ["first"],
    },
  });
  store.applyRuntimeEvent({
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-second",
      command: "second command",
      commandTokens: ["second"],
    },
  });

  let state = store.getThreadState("thread-1");
  assert.equal(state.status, "waiting_approval");
  assert.equal(state.pendingApproval.requestId, "req-first");
  assert.deepEqual(state.pendingApprovals.map((approval) => approval.requestId), ["req-second"]);

  store.resolveApproval("thread-1", "running", "req-first");
  state = store.getThreadState("thread-1");
  assert.equal(state.status, "waiting_approval");
  assert.equal(state.pendingApproval.requestId, "req-second");
  assert.deepEqual(state.pendingApprovals, []);

  store.resolveApproval("thread-1", "running", "req-second");
  state = store.getThreadState("thread-1");
  assert.equal(state.status, "running");
  assert.equal(state.pendingApproval, null);
  assert.deepEqual(state.pendingApprovals, []);
});

test("thread state delivers three back-to-back approvals in request order", () => {
  const store = new ThreadStateStore();

  for (const requestId of ["req-first", "req-second", "req-third"]) {
    store.applyRuntimeEvent({
      type: "runtime.approval.requested",
      payload: {
        threadId: "thread-1",
        requestId,
        command: `${requestId} command`,
      },
    });
  }

  let state = store.getThreadState("thread-1");
  assert.equal(state.status, "waiting_approval");
  assert.equal(state.pendingApproval.requestId, "req-first");
  assert.deepEqual(state.pendingApprovals.map((approval) => approval.requestId), ["req-second", "req-third"]);

  for (const requestId of ["req-first", "req-second", "req-third"]) {
    store.resolveApproval("thread-1", "running", requestId);
    state = store.getThreadState("thread-1");
  }

  assert.equal(state.status, "running");
  assert.equal(state.pendingApproval, null);
  assert.deepEqual(state.pendingApprovals, []);
});

test("resolving a queued approval does not clear the visible approval", () => {
  const store = new ThreadStateStore();

  store.applyRuntimeEvent({
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-first",
      command: "first command",
    },
  });
  store.applyRuntimeEvent({
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-auto",
      command: "auto approved command",
    },
  });

  store.resolveApproval("thread-1", "running", "req-auto");
  const state = store.getThreadState("thread-1");
  assert.equal(state.status, "waiting_approval");
  assert.equal(state.pendingApproval.requestId, "req-first");
  assert.deepEqual(state.pendingApprovals, []);
});

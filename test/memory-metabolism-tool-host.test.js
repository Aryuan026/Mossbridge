const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ProjectToolHost } = require("../src/tools/tool-host");
const { MemoryMetabolismService } = require("../src/services/memory-metabolism-service");

test("memory mutation tools strip metabolism meta and record server ledger", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-tool-metabolism-"));
  const metabolism = new MemoryMetabolismService({
    config: {
      stateDir: path.join(root, "state"),
      asherieDataRoot: path.join(root, "data"),
      memoryMetabolismStateFile: path.join(root, "state", "memory-metabolism-state.json"),
    },
  });
  metabolism.writeState({
    attempts: {
      "dream-1": {
        attempt_id: "dream-1",
        status: "dispatched",
        created_at: new Date().toISOString(),
        source_record_ids: ["source-1"],
        source_records: [{
          record_id: "source-1",
          ts_utc: new Date().toISOString(),
          query: "source",
        }],
      },
    },
  });
  const host = new ProjectToolHost({
    services: {
      config: {},
      memoryMetabolism: metabolism,
      asherieMemory: {
        async writeWarmMaterial(args) {
          return {
            ok: true,
            record: {
              material_id: args.material_id || "memo-1",
              title: args.title || "Blue ribbon memory",
              body_markdown: args.body_markdown || "I remember this as a first-person warm card.",
              metabolism_attempt_id: args.metabolism_attempt_id,
            },
          };
        },
      },
    },
    runtimeContextStore: {
      resolveActiveContext() {
        return {};
      },
    },
  });

  const result = await host.invokeTool("mossbridge_memory_warm_write", {
    title: "Blue ribbon memory",
    body_markdown: "I remember this as a first-person warm card.",
    metabolism_attempt_id: "dream-1",
    source_record_ids: ["source-1"],
    userId: "user-1",
  }, {
    senderId: "user-1",
  });

  assert.equal(result.data.record.material_id, "memo-1");
  assert.equal(result.data.record.metabolism_attempt_id, undefined);
  const state = metabolism.readState();
  const mutations = metabolism.readMutationLedgerForAttempt("dream-1", state.attempts["dream-1"]);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].attempt_id, "dream-1");
  assert.equal(mutations[0].target, "warm_memory");
  assert.equal(mutations[0].action, "write");
  assert.equal(mutations[0].object_id, "memo-1");
  assert.deepEqual(mutations[0].source_ids, ["source-1"]);
});

test("memory mutation tools validate metabolism meta before changing stores", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-tool-metabolism-preflight-"));
  const metabolism = new MemoryMetabolismService({
    config: {
      stateDir: path.join(root, "state"),
      asherieDataRoot: path.join(root, "data"),
      memoryMetabolismStateFile: path.join(root, "state", "memory-metabolism-state.json"),
    },
  });
  metabolism.writeState({
    attempts: {
      "dream-1": {
        attempt_id: "dream-1",
        status: "dispatched",
        created_at: new Date().toISOString(),
        source_record_ids: ["source-1"],
        source_records: [{
          record_id: "source-1",
          ts_utc: new Date().toISOString(),
          query: "source",
        }],
      },
    },
  });
  let writes = 0;
  const host = new ProjectToolHost({
    services: {
      config: {},
      memoryMetabolism: metabolism,
      asherieMemory: {
        async writeWarmMaterial(args) {
          writes += 1;
          return {
            ok: true,
            record: {
              material_id: args.material_id || `memo-${writes}`,
              title: args.title || "Warm card",
              body_markdown: args.body_markdown || "I remember the evidence.",
            },
          };
        },
      },
    },
    runtimeContextStore: {
      resolveActiveContext() {
        return {};
      },
    },
  });

  await assert.rejects(async () => {
    await host.invokeTool("mossbridge_memory_warm_write", {
      title: "Missing attempt",
      body_markdown: "I remember this, but forgot the metabolism attempt id.",
    }, { senderId: "user-1" });
  }, /metabolism_attempt_id/);
  assert.equal(writes, 0);

  await assert.rejects(async () => {
    await host.invokeTool("mossbridge_memory_warm_write", {
      title: "Wrong source",
      body_markdown: "I remember this, but used the wrong source id.",
      metabolism_attempt_id: "dream-1",
      source_record_ids: ["source-missing"],
    }, { senderId: "user-1" });
  }, /do not belong to attempt/);
  assert.equal(writes, 0);

  await assert.rejects(async () => {
    await host.invokeTool("mossbridge_memory_warm_write", {
      title: "Missing source ids",
      body_markdown: "I remember this, but forgot the source ids.",
      metabolism_attempt_id: "dream-1",
    }, { senderId: "user-1" });
  }, /source_record_ids are required/);
  assert.equal(writes, 0);
});

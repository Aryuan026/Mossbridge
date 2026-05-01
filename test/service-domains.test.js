const test = require("node:test");
const assert = require("node:assert/strict");

const { createServiceDomains } = require("../src/services/service-domains");

test("service domains expose gateway-shaped wrappers over the existing services", async () => {
  const calls = [];
  const whereaboutsService = {
    server: { name: "whereabouts-server" },
    async startServer(args) {
      calls.push(["presence.startServer", args]);
      return this.server;
    },
    async closeServer() {
      calls.push(["presence.closeServer"]);
    },
  };
  const domains = createServiceDomains({
    asherieMemory: {
      async captureContextPacket(args) {
        calls.push(["memory.captureContextPacket", args]);
        return { ok: true };
      },
      async writebackTurn(args) {
        calls.push(["memory.writebackTurn", args]);
        return { ok: true };
      },
      async writeWarmMaterial(args) {
        calls.push(["memory.writeWarmMaterial", args]);
        return { ok: true };
      },
      async readWarmMaterial(args) {
        calls.push(["memory.readWarmMaterial", args]);
        return { ok: true };
      },
      async searchWarmMaterials(args) {
        calls.push(["memory.searchWarmMaterials", args]);
        return { hits: [] };
      },
      async listWarmMaterials(args) {
        calls.push(["memory.listWarmMaterials", args]);
        return { items: [] };
      },
      async updateWarmMaterial(args) {
        calls.push(["memory.updateWarmMaterial", args]);
        return { ok: true };
      },
      async deleteWarmMaterial(args) {
        calls.push(["memory.deleteWarmMaterial", args]);
        return { ok: true };
      },
      async upsertOngoingTrack(args) {
        calls.push(["memory.upsertOngoingTrack", args]);
        return { ok: true };
      },
      async readOngoingTrack(args) {
        calls.push(["memory.readOngoingTrack", args]);
        return { ok: true };
      },
      async listOngoingTracks(args) {
        calls.push(["memory.listOngoingTracks", args]);
        return { items: [] };
      },
      async closeOngoingTrack(args) {
        calls.push(["memory.closeOngoingTrack", args]);
        return { ok: true };
      },
      async listColdVersions(args) {
        calls.push(["memory.listColdVersions", args]);
        return { versions: [] };
      },
      async readColdVersion(args) {
        calls.push(["memory.readColdVersion", args]);
        return { ok: true };
      },
      async searchColdRoots(args) {
        calls.push(["memory.searchColdRoots", args]);
        return { hits: [] };
      },
      async readColdRoot(args) {
        calls.push(["memory.readColdRoot", args]);
        return { ok: true };
      },
      async patchColdRoot(args) {
        calls.push(["memory.patchColdRoot", args]);
        return { ok: true };
      },
      async upsertColdVersion(args) {
        calls.push(["memory.upsertColdVersion", args]);
        return { version: "v1" };
      },
      describe() {
        calls.push(["memory.describe"]);
        return { id: "asherie_memory" };
      },
    },
    diary: {
      async append(args) {
        calls.push(["memory.appendDiary", args]);
        return { filePath: "/tmp/diary.md" };
      },
    },
    reminder: {
      async create(args, context) {
        calls.push(["wakeup.scheduleReminder", args, context]);
        return { id: "rem-1" };
      },
    },
    system: {
      queueMessage(args, context) {
        calls.push(["systemTurn.queueMessage", args, context]);
        return { id: "sys-1" };
      },
    },
    channelFile: {
      async sendToCurrentChat(args, context) {
        calls.push(["transport.sendFile", args, context]);
        return { filePath: args.filePath };
      },
    },
    sticker: {
      async list(args) {
        calls.push(["transport.listStickers", args]);
        return { stickers: [] };
      },
      async pick(args) {
        calls.push(["transport.pickSticker", args]);
        return { candidates: [] };
      },
      async sendToCurrentChat(args, context) {
        calls.push(["transport.sendSticker", args, context]);
        return { stickerId: args.stickerId };
      },
      async saveFromInbox(args, context) {
        calls.push(["transport.saveSticker", args, context]);
        return { createdCount: 1 };
      },
    },
    timeline: {
      async read(args) {
        calls.push(["calendar.read", args]);
        return { data: { date: args.date } };
      },
      async captureScreenshot(args) {
        calls.push(["calendar.captureScreenshot", args]);
        return { outputFile: "/tmp/shot.png" };
      },
      queueScreenshot(args, context) {
        calls.push(["calendar.queueScreenshot", args, context]);
        return { id: "shot-1" };
      },
    },
    whereabouts: whereaboutsService,
  });

  await domains.memory.appendDiary({ text: "hello" });
  await domains.memory.captureContextPacket({ query: "coffee" });
  await domains.memory.writebackTurn({ query: "hello" });
  await domains.memory.writeWarmMaterial({ title: "Coffee", body_markdown: "Likes pour-over." });
  await domains.memory.readWarmMaterial({ material_id: "memo-1" });
  await domains.memory.searchWarmMaterials({ query: "coffee" });
  await domains.memory.listWarmMaterials({ limit: 5 });
  await domains.memory.updateWarmMaterial({ material_id: "memo-1", summary: "Updated" });
  await domains.memory.deleteWarmMaterial({ material_id: "memo-1" });
  await domains.memory.upsertOngoingTrack({ title: "减重", summary: "最近在减重。" });
  await domains.memory.readOngoingTrack({ track_id: "track-1" });
  await domains.memory.listOngoingTracks({ statuses: ["active"] });
  await domains.memory.closeOngoingTrack({ track_id: "track-1", closure_summary: "阶段完成" });
  await domains.memory.listColdVersions({});
  await domains.memory.readColdVersion({ version: "v1" });
  await domains.memory.searchColdRoots({ query: "timezone" });
  await domains.memory.readColdRoot({ root_key: "hard_fact:f1" });
  await domains.memory.patchColdRoot({ root_key: "hard_fact:f1", changes: { fact_value: "UTC+8" } });
  await domains.memory.upsertColdVersion({ payload: { hard_facts: [] } });
  await domains.wakeup.scheduleReminder({ text: "wake me" }, { senderId: "user-1" });
  domains.wakeup.queueSystemTurn({ text: "system" }, { workspaceRoot: "/workspace" });
  await domains.calendar.read({ date: "2026-04-23" });
  await domains.calendar.captureScreenshot({ range: "day" });
  domains.calendar.queueScreenshot({ userId: "user-1" }, {});
  await domains.transport.sendFileToCurrentChat({ filePath: "/tmp/a.txt" }, {});
  await domains.transport.listStickers({ tag: "开心" });
  await domains.transport.pickSticker({ tag: "开心" });
  await domains.transport.sendStickerToCurrentChat({ stickerId: "stk_001" }, { senderId: "user-1" });
  await domains.transport.saveStickerFromInbox({ items: [] }, { senderId: "user-1" });
  await domains.presence.startWhereaboutsServer({ onAccepted() {} });
  await domains.presence.closeWhereaboutsServer();

  assert.deepEqual(calls, [
    ["memory.appendDiary", { text: "hello" }],
    ["memory.captureContextPacket", { query: "coffee" }],
    ["memory.writebackTurn", { query: "hello" }],
    ["memory.writeWarmMaterial", { title: "Coffee", body_markdown: "Likes pour-over." }],
    ["memory.readWarmMaterial", { material_id: "memo-1" }],
    ["memory.searchWarmMaterials", { query: "coffee" }],
    ["memory.listWarmMaterials", { limit: 5 }],
    ["memory.updateWarmMaterial", { material_id: "memo-1", summary: "Updated" }],
    ["memory.deleteWarmMaterial", { material_id: "memo-1" }],
    ["memory.upsertOngoingTrack", { title: "减重", summary: "最近在减重。" }],
    ["memory.readOngoingTrack", { track_id: "track-1" }],
    ["memory.listOngoingTracks", { statuses: ["active"] }],
    ["memory.closeOngoingTrack", { track_id: "track-1", closure_summary: "阶段完成" }],
    ["memory.listColdVersions", {}],
    ["memory.readColdVersion", { version: "v1" }],
    ["memory.searchColdRoots", { query: "timezone" }],
    ["memory.readColdRoot", { root_key: "hard_fact:f1" }],
    ["memory.patchColdRoot", { root_key: "hard_fact:f1", changes: { fact_value: "UTC+8" } }],
    ["memory.upsertColdVersion", { payload: { hard_facts: [] } }],
    ["wakeup.scheduleReminder", { text: "wake me" }, { senderId: "user-1" }],
    ["systemTurn.queueMessage", { text: "system" }, { workspaceRoot: "/workspace" }],
    ["calendar.read", { date: "2026-04-23" }],
    ["calendar.captureScreenshot", { range: "day" }],
    ["calendar.queueScreenshot", { userId: "user-1" }, {}],
    ["transport.sendFile", { filePath: "/tmp/a.txt" }, {}],
    ["transport.listStickers", { tag: "开心" }],
    ["transport.pickSticker", { tag: "开心" }],
    ["transport.sendSticker", { stickerId: "stk_001" }, { senderId: "user-1" }],
    ["transport.saveSticker", { items: [] }, { senderId: "user-1" }],
    ["presence.startServer", { onAccepted: calls[29][1].onAccepted }],
    ["presence.closeServer"],
  ]);
  assert.equal(domains.presence.getWhereaboutsServer(), whereaboutsService.server);
  assert.equal(domains.raw.whereabouts, whereaboutsService);
  assert.ok(domains.raw.sticker);
});

test("service domains keep memory relay hooks explicit until an asherie adapter is installed", async () => {
  const domains = createServiceDomains({});
  await assert.rejects(async () => {
    await domains.memory.captureContextPacket({});
  }, /service is not configured/);
  await assert.rejects(async () => {
    await domains.memory.writebackTurn({});
  }, /service is not configured/);
});

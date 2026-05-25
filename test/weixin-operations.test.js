const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("weixin operations memory guidance stays operational instead of styling the front-stage voice", () => {
  const templatePath = path.join(__dirname, "..", "templates", "weixin-operations.md");
  const raw = fs.readFileSync(templatePath, "utf8");
  const memorySectionMatch = raw.match(/## Memory Use\s*([\s\S]*?)$/);
  const memorySection = memorySectionMatch ? memorySectionMatch[1] : "";

  assert.match(memorySection, /change what information is available/i);
  assert.match(memorySection, /front-stage wording, persona, and behavior style still come from the living context/i);
  assert.match(memorySection, /Treat proactive surfacing as a starting hint/i);
  assert.match(memorySection, /broad basis but a narrower landing point/i);
  assert.match(memorySection, /Use observation journal notes for revisable companionship patterns/i);
  assert.match(memorySection, /write a note proactively and silently/i);
  assert.match(memorySection, /status: rejected/i);
  assert.match(memorySection, /Case guidance is storage routing only/i);
  assert.match(memorySection, /ticket, changelog, or engineering-report mode/i);
  assert.doesNotMatch(memorySection, /same natural wechat tone/i);
  assert.doesNotMatch(memorySection, /flatten your wording/i);
  assert.doesNotMatch(memorySection, /emoji|客服腔|语气|人格与关系/i);
  assert.doesNotMatch(memorySection, /\bher\b|\bshe\b|她/i);
});

test("weixin operations front-stage guidance allows fuller replies without forcing a question ending", () => {
  const templatePath = path.join(__dirname, "..", "templates", "weixin-operations.md");
  const raw = fs.readFileSync(templatePath, "utf8");

  assert.match(raw, /treat generic runtime-level brevity instructions/i);
  assert.match(raw, /Let each turn find its own landing shape/i);
  assert.match(raw, /clear emotional landing point/i);
  assert.match(raw, /too thin for this channel/i);
});

test("weixin operations explains sticker use without forcing sticker spam", () => {
  const templatePath = path.join(__dirname, "..", "templates", "weixin-operations.md");
  const raw = fs.readFileSync(templatePath, "utf8");

  assert.match(raw, /Stickers are a WeChat expression action/i);
  assert.match(raw, /The normal sticker flow is/i);
  assert.match(raw, /active sticker drawer/i);
  assert.match(raw, /Archived sticker packs are a larger wardrobe/i);
  assert.match(raw, /One fitting sticker is usually enough/i);
});

test("weixin operations separates random checkins from AI-calendar tool wakeups", () => {
  const templatePath = path.join(__dirname, "..", "templates", "weixin-operations.md");
  const raw = fs.readFileSync(templatePath, "utf8");

  assert.match(raw, /Use reminders as an AI calendar/i);
  assert.match(raw, /wake with tools/i);
  assert.match(raw, /lightweight reconnection window/i);
  assert.match(raw, /no tools/i);
  assert.match(raw, /schedule it as an AI-calendar reminder/i);
  assert.match(raw, /Store shareable outcomes and evidence/i);
});

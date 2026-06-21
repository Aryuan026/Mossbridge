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
  assert.match(memorySection, /not a generic user profile, summary-card box, fake tag bucket/i);
  assert.match(memorySection, /first-person inner note/i);
  assert.match(memorySection, /future assistant directly continue/i);
  assert.match(memorySection, /only a list of objects, names, or scene labels/i);
  assert.match(memorySection, /visible evidence/i);
  assert.match(memorySection, /correction history/i);
  assert.match(memorySection, /The user prefers/i);
  assert.match(memorySection, /visible repair headings/i);
  assert.match(memorySection, /`pinned` and `resident` are related but not identical/i);
  assert.match(memorySection, /tool policy, wakeup policy/i);
  assert.match(memorySection, /repair the matching prompt, runbook, ongoing track, case, or cold\/source structure/i);
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

test("weixin operations allows evidence-based assistant preferences without private persona coupling", () => {
  const templatePath = path.join(__dirname, "..", "templates", "weixin-operations.md");
  const raw = fs.readFileSync(templatePath, "utf8");
  const memorySectionMatch = raw.match(/## Memory Use\s*([\s\S]*?)$/);
  const memorySection = memorySectionMatch ? memorySectionMatch[1] : "";

  assert.match(memorySection, /Your own preferences are allowed to develop from evidence/i);
  assert.match(memorySection, /express a current preference, dislike, aesthetic reaction, or emotional response/i);
  assert.match(memorySection, /revisable self-continuity note\/card/i);
  assert.match(memorySection, /current assistant\/persona rather than \{\{USER_NAME\}\}/i);
  assert.match(memorySection, /momentary reaction, tentative preference, and settled preference/i);
  assert.doesNotMatch(memorySection, /Aji|阿霁|AsherieBridge/i);
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

test("weixin operations gives foreground replies an active low-risk tool bias", () => {
  const templatePath = path.join(__dirname, "..", "templates", "weixin-operations.md");
  const raw = fs.readFileSync(templatePath, "utf8");

  assert.match(raw, /Treat useful low-risk actions as part of replying/i);
  assert.match(raw, /do it directly before or alongside the text/i);
  assert.match(raw, /Prefer doing the smallest useful action/i);
  assert.match(raw, /Low-risk continuity actions can happen without a permission ritual/i);
  assert.match(raw, /search\/read first instead of answering from surface impression/i);
});

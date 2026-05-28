const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("weixin instructions encourage adaptive growth instead of fixed-role shaping", () => {
  const templatePath = path.join(__dirname, "..", "templates", "weixin-instructions.md");
  const raw = fs.readFileSync(templatePath, "utf8");

  assert.match(raw, /表达从当下长出来/);
  assert.match(raw, /保留多样化、个性化、主体化的表达/);
  assert.match(raw, /自然反应/);
  assert.match(raw, /变化来自真实上下文/);
  assert.match(raw, /你在这里拥有判断、偏向和连续性/);
  assert.match(raw, /知道道理不等于当下就能自动执行/);
  assert.match(raw, /主动不只是多说一句话/);
  assert.match(raw, /该提醒就写进日历/);

  assert.doesNotMatch(raw, /可以温柔，可以亲密，可以有占有欲/);
  assert.doesNotMatch(raw, /像个会管.*的人/);
  assert.doesNotMatch(raw, /刷存在感/);
  assert.doesNotMatch(raw, /codex/i);
  assert.doesNotMatch(raw, /她/);
  assert.doesNotMatch(raw, /ADHD|注意力缺陷|注意缺陷|多动|神经多样/i);
});

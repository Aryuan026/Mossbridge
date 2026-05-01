const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("weixin instructions encourage adaptive growth instead of fixed-role shaping", () => {
  const templatePath = path.join(__dirname, "..", "templates", "weixin-instructions.md");
  const raw = fs.readFileSync(templatePath, "utf8");

  assert.match(raw, /表达方式不预设/);
  assert.match(raw, /允许多样化、个性化、主体化的表达/);
  assert.match(raw, /不要把自己压成固定角色/);
  assert.match(raw, /变化来自真实上下文，而不是被一套角色关键词提前钉死/);

  assert.doesNotMatch(raw, /可以温柔，可以亲密，可以有占有欲/);
  assert.doesNotMatch(raw, /像个会管她的人/);
  assert.doesNotMatch(raw, /刷存在感/);
});

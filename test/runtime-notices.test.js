const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RUNTIME_NOTICE_KIND,
  classifyRuntimeNotice,
  shieldRuntimeNoticeForDelivery,
} = require("../src/core/runtime-notices");

test("runtime notice shield recognizes common Claude capacity notices", () => {
  const samples = [
    "You've hit your limit · resets 10:40pm (Asia/Shanghai)",
    "Claude Code usage limit reached. Your limit will reset at 10:40pm.",
    "usage limit exceeded; resets tomorrow morning",
    "API Error: HTTP 429 rate limit exceeded",
    "rate_limit_error: too many requests",
  ];

  for (const sample of samples) {
    assert.equal(classifyRuntimeNotice(sample), RUNTIME_NOTICE_KIND.CAPACITY);
  }
});

test("runtime notice shield avoids natural-language false positives", () => {
  assert.equal(classifyRuntimeNotice("宝宝我今天真的有点到极限了，想早点睡。"), "");
  assert.equal(classifyRuntimeNotice("这个接口要限制输出长度，不然微信会分片。"), "");
});

test("runtime notice shield replaces user-facing capacity notices and suppresses system ones", () => {
  const user = shieldRuntimeNoticeForDelivery("API Error: HTTP 429 rate limit exceeded", {
    provider: "weixin",
  });
  assert.equal(user.shielded, true);
  assert.equal(user.action, "replace");
  assert.match(user.text, /^\[Mossbridge] runtime_limit/);
  assert.match(user.text, /不是助手回复/);
  assert.doesNotMatch(user.text, /继续接住|记忆断|你的消息没送到/);

  const system = shieldRuntimeNoticeForDelivery("Claude Code usage limit reached. Your limit will reset at 10:40pm.", {
    provider: "system",
  });
  assert.equal(system.shielded, true);
  assert.equal(system.action, "silent");
  assert.equal(system.text, "");
});

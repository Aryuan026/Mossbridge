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
  assert.equal(classifyRuntimeNotice("朋友我今天真的有点到极限了，想早点睡。"), "");
  assert.equal(classifyRuntimeNotice("这个接口要限制输出长度，不然微信会分片。"), "");
});

test("runtime notice shield distinguishes capacity warnings from hard cooldowns", () => {
  assert.equal(
    classifyRuntimeNotice("Claude Code: you have 5 messages remaining until reset."),
    RUNTIME_NOTICE_KIND.CAPACITY_WARNING,
  );
  assert.equal(
    classifyRuntimeNotice("You have 2 requests left before reset."),
    RUNTIME_NOTICE_KIND.CAPACITY_WARNING,
  );
});

test("runtime notice shield replaces user-facing capacity notices and suppresses system ones", () => {
  const user = shieldRuntimeNoticeForDelivery("API Error: HTTP 429 rate limit exceeded", {
    provider: "weixin",
  });
  assert.equal(user.shielded, true);
  assert.equal(user.action, "replace");
  assert.match(user.text, /^\[Mossbridge] runtime_limit/);
  assert.match(user.text, /source: bridge/);
  assert.match(user.text, /status: rate_or_quota_limited/);
  assert.match(user.text, /result: no_runtime_reply/);
  assert.doesNotMatch(user.text, /继续接住|记忆断|你的消息没送到/);

  const system = shieldRuntimeNoticeForDelivery("Claude Code usage limit reached. Your limit will reset at 10:40pm.", {
    provider: "system",
  });
  assert.equal(system.shielded, true);
  assert.equal(system.action, "silent");
  assert.equal(system.text, "");
});

test("runtime notice shield rewrites capacity warnings as bridge status without hard cooldown wording", () => {
  const user = shieldRuntimeNoticeForDelivery("Claude Code: you have 5 messages remaining until reset.", {
    provider: "weixin",
  });
  assert.equal(user.shielded, true);
  assert.equal(user.kind, RUNTIME_NOTICE_KIND.CAPACITY_WARNING);
  assert.equal(user.action, "replace");
  assert.match(user.text, /^\[Mossbridge] runtime_usage_warning/);
  assert.match(user.text, /source: bridge/);
  assert.match(user.text, /runtime: ClaudeCode/);
  assert.match(user.text, /status: usage_warning/);
  assert.match(user.text, /result: runtime_still_available/);
  assert.doesNotMatch(user.text, /继续接住|记忆断|你的消息没送到/);
});

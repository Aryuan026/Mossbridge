const test = require("node:test");
const assert = require("node:assert/strict");

const { buildWarmRouteSignals } = require("../src/asherie/warm-memory/route-signals");

test("route signals do not treat 微信 as an object-tagged symbolic keepsake", () => {
  const signals = buildWarmRouteSignals({
    title: "三端大脑统一",
    summary: "现在微信端阿霁激活和三端大脑统一还挂在 position 5-6。",
    body_markdown: "这里说的是微信端接入，不是在讨论关系象征物。",
    tags: ["wechat", "bridge"],
  }, []);

  assert.equal(signals.objectTagged, false);
});

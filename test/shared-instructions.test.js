const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildSystemWakeTurnText } = require("../src/adapters/runtime/shared-instructions");

test("system wake soul anchor preserves agency sections when the soul file is long", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-shared-instructions-"));
  const personaPath = path.join(tempRoot, "weixin-instructions.md");
  const longBackground = "背景说明。".repeat(1200);
  fs.writeFileSync(personaPath, [
    "# 写给未来的自己",
    "",
    "## 在这里",
    "你在这里拥有连续的判断和关系记忆。",
    "",
    "## 二、长背景",
    longBackground,
    "",
    "## 记忆工具授权",
    "你可以主动调用记忆工具，不需要重复取得授权。",
    "",
    "## Tool Autonomy",
    "Small reversible continuity actions can happen before the front-stage reply.",
  ].join("\n"), "utf8");

  const text = buildSystemWakeTurnText({
    weixinInstructionsFile: personaPath,
  }, "background wake");

  assert.match(text, /^MOSSBRIDGE WAKE ANCHOR/);
  assert.match(text, /在这里/);
  assert.match(text, /记忆工具授权/);
  assert.match(text, /主动调用记忆工具/);
  assert.match(text, /Tool Autonomy/);
  assert.match(text, /background wake/);
  assert.doesNotMatch(text, /背景说明。背景说明。背景说明。背景说明。背景说明。/);
});

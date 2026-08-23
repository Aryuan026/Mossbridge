const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildInstructionRefreshText,
  buildOpeningTurnText,
  buildSystemWakeTurnText,
} = require("../src/adapters/runtime/shared-instructions");

test("opening instructions carry persona context without operational prompt ballast", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-shared-instructions-opening-"));
  const personaPath = path.join(tempRoot, "weixin-instructions.md");
  const operationsPath = path.join(tempRoot, "weixin-operations.md");
  fs.writeFileSync(personaPath, "关系入口：{{USER_NAME}}", "utf8");
  fs.writeFileSync(operationsPath, "后台操作提示不应该进入 opening", "utf8");

  const text = buildOpeningTurnText({
    userName: "Moss",
    weixinInstructionsFile: personaPath,
    weixinOperationsFile: operationsPath,
  }, "现在接着说");

  assert.match(text, /关系入口：Moss/);
  assert.match(text, /现在接着说/);
  assert.doesNotMatch(text, /后台操作提示不应该进入 opening/);
});

test("instruction refresh keeps persona context without replaying operational prompt ballast", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-shared-instructions-refresh-"));
  const personaPath = path.join(tempRoot, "weixin-instructions.md");
  const operationsPath = path.join(tempRoot, "weixin-operations.md");
  fs.writeFileSync(personaPath, "关系入口：{{USER_NAME}}", "utf8");
  fs.writeFileSync(operationsPath, "后台操作提示不应该进入 refresh", "utf8");

  const text = buildInstructionRefreshText({
    userName: "Moss",
    weixinInstructionsFile: personaPath,
    weixinOperationsFile: operationsPath,
  });

  assert.match(text, /关系入口：Moss/);
  assert.doesNotMatch(text, /后台操作提示不应该进入 refresh/);
});

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

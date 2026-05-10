const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  listWeixinAccounts,
  saveWeixinAccount,
} = require("../src/adapters/channel/weixin/account-store");

function createConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-weixin-account-test-"));
  return {
    accountsDir: path.join(dir, "accounts"),
    weixinBaseUrl: "https://example.test",
  };
}

test("listWeixinAccounts ignores context token sidecar files", () => {
  const config = createConfig();
  saveWeixinAccount(config, "account-1", {
    token: "token-1",
    baseUrl: "https://example.test",
    userId: "bot-1",
  });
  fs.writeFileSync(path.join(config.accountsDir, "account-1.context-tokens.json"), "{}", "utf8");
  fs.writeFileSync(path.join(config.accountsDir, "account-1.context-token-meta.json"), "{}", "utf8");

  const accounts = listWeixinAccounts(config);

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accountId, "account-1");
});

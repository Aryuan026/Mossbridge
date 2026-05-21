const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { saveWeixinAccount } = require("../src/adapters/channel/weixin/account-store");
const { persistContextToken } = require("../src/adapters/channel/weixin/context-token-store");
const { ChannelFileService } = require("../src/services/channel-file-service");

test("ChannelFileService refuses oversized files before touching WeChat upload", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-channel-file-"));
  try {
    const filePath = path.join(tmpDir, "large.txt");
    fs.writeFileSync(filePath, "larger than the tiny test limit");
    const config = buildConfig(tmpDir, {
      channelFileMaxBytes: 8,
    });
    seedAccount(config);
    let sendFileCalls = 0;
    const service = new ChannelFileService({
      config,
      channelAdapter: {
        async sendTyping() {},
        async sendFile() {
          sendFileCalls += 1;
          return {};
        },
      },
    });

    await assert.rejects(
      () => service.sendToCurrentChat({ filePath }, { senderId: "user-1" }),
      (error) => {
        assert.equal(error.code, "CHANNEL_FILE_TOO_LARGE");
        assert.equal(error.channelFile.maxBytes, 8);
        return true;
      },
    );
    assert.equal(sendFileCalls, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ChannelFileService timeboxes slow WeChat file delivery and turns typing off", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-channel-file-"));
  try {
    const filePath = path.join(tmpDir, "case-note.txt");
    fs.writeFileSync(filePath, "case note");
    const config = buildConfig(tmpDir, {
      channelFileSendTimeoutMs: 2,
    });
    seedAccount(config);
    const typingStatuses = [];
    const service = new ChannelFileService({
      config,
      channelAdapter: {
        async sendTyping({ status }) {
          typingStatuses.push(status);
        },
        async sendFile() {
          return await new Promise(() => {});
        },
      },
    });

    await assert.rejects(
      () => service.sendToCurrentChat({ filePath }, { senderId: "user-1" }),
      (error) => {
        assert.equal(error.code, "CHANNEL_FILE_SEND_TIMEOUT");
        assert.equal(error.channelFile.timeoutMs, 2);
        return true;
      },
    );
    assert.deepEqual(typingStatuses, [1, 0]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ChannelFileService returns sent metadata for small files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-channel-file-"));
  try {
    const filePath = path.join(tmpDir, "small.txt");
    fs.writeFileSync(filePath, "hello");
    const config = buildConfig(tmpDir);
    seedAccount(config);
    const service = new ChannelFileService({
      config,
      channelAdapter: {
        async sendTyping() {},
        async sendFile({ filePath: sentPath }) {
          return { kind: "file", fileName: path.basename(sentPath) };
        },
      },
    });

    const result = await service.sendToCurrentChat({ filePath }, { senderId: "user-1" });
    assert.equal(result.ok, true);
    assert.equal(result.status, "sent");
    assert.equal(result.sizeBytes, 5);
    assert.equal(result.delivery.fileName, "small.txt");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function buildConfig(tmpDir, overrides = {}) {
  return {
    accountsDir: path.join(tmpDir, "accounts"),
    accountId: "account-1",
    weixinBaseUrl: "https://wechat.test",
    channelFileMaxBytes: 20 * 1024 * 1024,
    channelFileSendTimeoutMs: 120_000,
    ...overrides,
  };
}

function seedAccount(config) {
  saveWeixinAccount(config, config.accountId, {
    token: "token-1",
    baseUrl: config.weixinBaseUrl,
  });
  persistContextToken(config, config.accountId, "user-1", "ctx-1");
}

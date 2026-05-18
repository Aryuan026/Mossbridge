const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { sendWeixinMediaFile } = require("../src/adapters/channel/weixin/media-send");

test("sendWeixinMediaFile falls back to file delivery when the image media route is rejected", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-media-send-"));
  const imagePath = path.join(tmpDir, "hug.png");
  fs.writeFileSync(imagePath, "PNG");

  const uploadMediaTypes = [];
  const sentItems = [];

  await withFakeFetch(async (url, options = {}) => {
    const urlText = String(url);
    if (urlText.includes("/ilink/bot/getuploadurl")) {
      const body = JSON.parse(String(options.body || "{}"));
      uploadMediaTypes.push(body.media_type);
      if (body.media_type === 1) {
        return jsonResponse({ ret: -9, errcode: -9, errmsg: "image route unavailable" });
      }
      return jsonResponse({ ret: 0, errcode: 0, upload_param: `upload-${body.media_type}` });
    }
    if (urlText.includes("/upload?")) {
      return new Response("", {
        status: 200,
        headers: { "x-encrypted-param": "download-param" },
      });
    }
    if (urlText.includes("/ilink/bot/sendmessage")) {
      const body = JSON.parse(String(options.body || "{}"));
      sentItems.push(body?.msg?.item_list?.[0]);
      return jsonResponse({ ret: 0, errcode: 0 });
    }
    throw new Error(`Unexpected fetch url: ${urlText}`);
  }, async () => {
    const result = await sendWeixinMediaFile({
      filePath: imagePath,
      to: "user-a",
      contextToken: "ctx-a",
      baseUrl: "https://wechat.test/",
      token: "token-a",
      cdnBaseUrl: "https://cdn.test",
    });

    assert.equal(result.kind, "file");
    assert.equal(result.fallbackFrom, "image");
    assert.match(result.fallbackReason, /getUploadUrl ret=-9/);
  });

  assert.deepEqual(uploadMediaTypes, [1, 3]);
  assert.equal(sentItems.length, 1);
  assert.equal(sentItems[0].type, 4);
  assert.ok(sentItems[0].file_item);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("sendWeixinMediaFile does not retry image delivery as file when sendMessage has a stale context error", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-media-send-"));
  const imagePath = path.join(tmpDir, "hug.png");
  fs.writeFileSync(imagePath, "PNG");

  const uploadMediaTypes = [];
  let sendMessageCalls = 0;

  await withFakeFetch(async (url, options = {}) => {
    const urlText = String(url);
    if (urlText.includes("/ilink/bot/getuploadurl")) {
      const body = JSON.parse(String(options.body || "{}"));
      uploadMediaTypes.push(body.media_type);
      return jsonResponse({ ret: 0, errcode: 0, upload_param: `upload-${body.media_type}` });
    }
    if (urlText.includes("/upload?")) {
      return new Response("", {
        status: 200,
        headers: { "x-encrypted-param": "download-param" },
      });
    }
    if (urlText.includes("/ilink/bot/sendmessage")) {
      sendMessageCalls += 1;
      return jsonResponse({ ret: -2, errcode: 0, errmsg: "" });
    }
    throw new Error(`Unexpected fetch url: ${urlText}`);
  }, async () => {
    await assert.rejects(
      () => sendWeixinMediaFile({
        filePath: imagePath,
        to: "user-a",
        contextToken: "ctx-stale",
        baseUrl: "https://wechat.test/",
        token: "token-a",
        cdnBaseUrl: "https://cdn.test",
      }),
      /sendMessage ret=-2/
    );
  });

  assert.deepEqual(uploadMediaTypes, [1]);
  assert.equal(sendMessageCalls, 1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function withFakeFetch(fakeFetch, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

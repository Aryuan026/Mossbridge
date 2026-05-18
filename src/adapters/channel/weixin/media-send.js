const crypto = require("crypto");
const path = require("path");
const fs = require("fs/promises");

const { getUploadUrl, sendMessage } = require("./api");
const { getMimeFromFilename } = require("./media-mime");

const WEIXIN_MEDIA_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
};
const CDN_UPLOAD_ATTEMPTS = 3;
const CDN_UPLOAD_TIMEOUT_MS = 20_000;
const CDN_UPLOAD_RETRY_DELAYS_MS = [350, 900];

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function uploadBufferToCdn({ buf, uploadParam, filekey, cdnBaseUrl, aeskey }) {
  const ciphertext = encryptAesEcb(buf, aeskey);
  const cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  let lastError = null;
  for (let attempt = 1; attempt <= CDN_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchCdnUpload(cdnUrl, ciphertext);
      if (response.status !== 200) {
        const errMsg = response.headers.get("x-error-message") || await response.text();
        const error = new Error(`CDN upload failed status=${response.status}: ${errMsg || response.status}`);
        error.status = response.status;
        if (!isRetryableCdnError(error) || attempt >= CDN_UPLOAD_ATTEMPTS) {
          throw error;
        }
        lastError = error;
      } else {
        const downloadParam = response.headers.get("x-encrypted-param") || "";
        if (!downloadParam) {
          throw new Error("CDN upload response missing x-encrypted-param header");
        }
        return { downloadParam };
      }
    } catch (error) {
      if (!isRetryableCdnError(error) || attempt >= CDN_UPLOAD_ATTEMPTS) {
        throw error;
      }
      lastError = error;
    }
    await sleep(CDN_UPLOAD_RETRY_DELAYS_MS[Math.min(attempt - 1, CDN_UPLOAD_RETRY_DELAYS_MS.length - 1)]);
  }
  throw lastError || new Error("CDN upload failed");
}

async function fetchCdnUpload(cdnUrl, ciphertext) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDN_UPLOAD_TIMEOUT_MS);
  try {
    return await fetch(cdnUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(ciphertext),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableCdnError(error) {
  const status = Number(error?.status || 0);
  if (status >= 500 && status < 600) {
    return true;
  }
  const name = String(error?.name || "");
  const message = String(error?.message || "").toLowerCase();
  return name === "AbortError"
    || message.includes("fetch failed")
    || message.includes("network")
    || message.includes("econnreset")
    || message.includes("etimedout")
    || message.includes("socket")
    || message.includes("aborted");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadMediaToWeixin({ filePath, toUserId, opts, cdnBaseUrl, mediaType }) {
  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const uploadUrlResp = await getUploadUrl({
    ...opts,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });

  const uploadParam = uploadUrlResp?.upload_param || "";
  if (!uploadParam) {
    throw new Error("getUploadUrl returned no upload_param");
  }

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadParam,
    filekey,
    cdnBaseUrl,
    aeskey,
  });

  return {
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

function buildMediaRef(uploaded) {
  return {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
    encrypt_type: 1,
  };
}

async function sendMediaItem({ to, item, contextToken, baseUrl, token }) {
  await sendMessage({
    baseUrl,
    token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        item_list: [item],
        context_token: contextToken,
      },
    },
  });
}

async function sendImageMediaFile({ filePath, to, contextToken, baseUrl, token, cdnBaseUrl, uploadOpts }) {
  const uploaded = await uploadMediaToWeixin({
    filePath,
    toUserId: to,
    opts: uploadOpts,
    cdnBaseUrl,
    mediaType: WEIXIN_MEDIA_TYPE.IMAGE,
  });
  await sendMediaItem({
    to,
    contextToken,
    baseUrl,
    token,
    item: {
      type: 2,
      image_item: {
        media: buildMediaRef(uploaded),
        aeskey: uploaded.aeskey,
        mid_size: uploaded.fileSizeCiphertext,
        hd_size: uploaded.fileSizeCiphertext,
      },
    },
  });
  return { kind: "image", fileName: path.basename(filePath) };
}

async function sendVideoMediaFile({ filePath, to, contextToken, baseUrl, token, cdnBaseUrl, uploadOpts }) {
  const uploaded = await uploadMediaToWeixin({
    filePath,
    toUserId: to,
    opts: uploadOpts,
    cdnBaseUrl,
    mediaType: WEIXIN_MEDIA_TYPE.VIDEO,
  });
  await sendMediaItem({
    to,
    contextToken,
    baseUrl,
    token,
    item: {
      type: 5,
      video_item: {
        media: buildMediaRef(uploaded),
        video_size: uploaded.fileSizeCiphertext,
      },
    },
  });
  return { kind: "video", fileName: path.basename(filePath) };
}

async function sendGenericFileMediaFile({
  filePath,
  to,
  contextToken,
  baseUrl,
  token,
  cdnBaseUrl,
  uploadOpts,
  fallbackFrom = "",
  fallbackReason = "",
}) {
  const uploaded = await uploadMediaToWeixin({
    filePath,
    toUserId: to,
    opts: uploadOpts,
    cdnBaseUrl,
    mediaType: WEIXIN_MEDIA_TYPE.FILE,
  });
  await sendMediaItem({
    to,
    contextToken,
    baseUrl,
    token,
    item: {
      type: 4,
      file_item: {
        media: buildMediaRef(uploaded),
        file_name: path.basename(filePath),
        len: String(uploaded.fileSize),
      },
    },
  });
  return {
    kind: "file",
    fileName: path.basename(filePath),
    fallbackFrom,
    fallbackReason,
  };
}

function shouldFallbackImageAsFile(error) {
  const apiLabel = String(error?.weixinApi?.label || "");
  const message = formatMediaError(error).toLowerCase();
  if (apiLabel === "sendMessage" || message.includes("sendmessage ret=-2")) {
    return false;
  }
  return true;
}

function formatMediaError(error) {
  if (error instanceof Error) {
    return error.message || error.name || "unknown error";
  }
  return String(error || "unknown error");
}

function buildMediaFallbackError(primaryError, fallbackError) {
  const error = new Error([
    `Image media delivery failed: ${formatMediaError(primaryError)}`,
    `file fallback failed: ${formatMediaError(fallbackError)}`,
  ].join("; "));
  error.primaryError = primaryError;
  error.fallbackError = fallbackError;
  return error;
}

async function sendWeixinMediaFile({ filePath, to, contextToken, baseUrl, token, cdnBaseUrl }) {
  if (!contextToken) {
    throw new Error("sendWeixinMediaFile requires contextToken");
  }

  const mime = getMimeFromFilename(filePath);
  const uploadOpts = { baseUrl, token };

  if (mime.startsWith("image/")) {
    try {
      return await sendImageMediaFile({
        filePath,
        to,
        contextToken,
        baseUrl,
        token,
        cdnBaseUrl,
        uploadOpts,
      });
    } catch (error) {
      if (!shouldFallbackImageAsFile(error)) {
        throw error;
      }
      try {
        return await sendGenericFileMediaFile({
          filePath,
          to,
          contextToken,
          baseUrl,
          token,
          cdnBaseUrl,
          uploadOpts,
          fallbackFrom: "image",
          fallbackReason: formatMediaError(error),
        });
      } catch (fallbackError) {
        throw buildMediaFallbackError(error, fallbackError);
      }
    }
  }

  if (mime.startsWith("video/")) {
    return sendVideoMediaFile({
      filePath,
      to,
      contextToken,
      baseUrl,
      token,
      cdnBaseUrl,
      uploadOpts,
    });
  }

  return sendGenericFileMediaFile({
    filePath,
    to,
    contextToken,
    baseUrl,
    token,
    cdnBaseUrl,
    uploadOpts,
  });
}

module.exports = { sendWeixinMediaFile };

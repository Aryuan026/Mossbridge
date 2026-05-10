const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { resolveWorkspaceOfficePaths } = require("../../../core/workspace-office-layout");

const MAX_FILE_NAME_LENGTH = 120;
const MAX_AUTO_NOTE_SUMMARY_CHARS = 700;
const MAX_AUTO_NOTE_DETAILS_CHARS = 4000;
const ATTACHMENT_DOWNLOAD_RETRY_DELAYS_MS = [0, 500, 1_500];

async function persistIncomingWeixinAttachments({
  attachments,
  config = {},
  workspaceRoot = "",
  stateDir,
  cdnBaseUrl,
  messageId = "",
  receivedAt = "",
  messageText = "",
}) {
  const saved = [];
  const failed = [];
  const officePaths = resolveWorkspaceOfficePaths({
    workspaceRoot,
    config: {
      ...config,
      stateDir,
    },
  });

  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    try {
      const persisted = await persistSingleAttachment({
        attachment,
        officePaths,
        cdnBaseUrl,
        messageId,
        receivedAt,
        messageText,
      });
      saved.push(persisted);
    } catch (error) {
      failed.push({
        kind: attachment?.kind || "file",
        sourceFileName: attachment?.fileName || "",
        reason: error instanceof Error ? error.message : String(error || "unknown attachment error"),
      });
    }
  }

  return { saved, failed };
}

async function persistSingleAttachment({ attachment, officePaths, cdnBaseUrl, messageId, receivedAt, messageText }) {
  const download = await downloadAttachmentPayload(attachment, cdnBaseUrl);
  const plaintext = decodeAttachmentPayload(download.bytes, attachment, download.contentType);
  const fileName = buildTargetFileName({
    attachment,
    plaintext,
    contentType: download.contentType,
    messageId,
  });
  const dateFolder = normalizeDateFolder(receivedAt);
  const targetDir = buildInboxDirectory(officePaths.inboxRoot, dateFolder);
  const absolutePath = await writeUniqueFile(targetDir, fileName, plaintext);
  const noteAbsolutePath = await ensureAttachmentNote({
    officePaths,
    dateFolder,
    absolutePath,
    fileName: path.basename(absolutePath),
    attachment,
    contentType: download.contentType,
    receivedAt,
    messageText,
  });
  await appendAttachmentJournal({
    officePaths,
    absolutePath,
    noteAbsolutePath,
    attachment,
    contentType: download.contentType,
    receivedAt,
    messageId,
    sizeBytes: plaintext.length,
    messageText,
  });
  const relativePath = officePaths.workspaceRoot
    ? path.relative(officePaths.workspaceRoot, absolutePath).replace(/\\/g, "/")
    : path.basename(absolutePath);
  const noteRelativePath = officePaths.workspaceRoot && noteAbsolutePath
    ? path.relative(officePaths.workspaceRoot, noteAbsolutePath).replace(/\\/g, "/")
    : "";

  return {
    kind: attachment.kind || "file",
    contentType: download.contentType,
    isImage: isImageAttachment({
      kind: attachment.kind,
      contentType: download.contentType,
      fileName,
    }),
    sourceFileName: attachment.fileName || "",
    fileName: path.basename(absolutePath),
    absolutePath,
    relativePath,
    noteAbsolutePath,
    noteRelativePath,
    sizeBytes: plaintext.length,
  };
}

function buildInboxDirectory(inboxRoot, dateFolder) {
  return path.join(inboxRoot, dateFolder);
}

function normalizeDateFolder(receivedAt) {
  const date = receivedAt ? new Date(receivedAt) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

async function downloadAttachmentPayload(attachment, cdnBaseUrl) {
  const candidates = buildDownloadCandidates(attachment, cdnBaseUrl);
  if (!candidates.length) {
    throw new Error("attachment did not include a supported download reference");
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await downloadCandidateWithRetries(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("attachment download failed");
}

async function downloadCandidateWithRetries(candidate) {
  let lastError = null;
  for (let index = 0; index < ATTACHMENT_DOWNLOAD_RETRY_DELAYS_MS.length; index += 1) {
    const delayMs = ATTACHMENT_DOWNLOAD_RETRY_DELAYS_MS[index];
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    try {
      return await downloadCandidateOnce(candidate);
    } catch (error) {
      lastError = error;
      if (!isRetriableAttachmentDownloadError(error)) {
        break;
      }
    }
  }
  throw lastError || new Error("attachment download failed");
}

async function downloadCandidateOnce(candidate) {
  const response = await fetch(candidate, {
    method: "GET",
    headers: {
      Accept: "*/*",
    },
  });
  if (!response.ok) {
    const error = new Error(`download failed with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    bytes: Buffer.from(arrayBuffer),
    contentType: normalizeContentType(response.headers.get("content-type")),
  };
}

function isRetriableAttachmentDownloadError(error) {
  const status = Number(error?.status);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }
  const message = String(error?.message || error || "");
  return /fetch failed|network|socket|timeout|timed out|econnreset|etimedout|eai_again|aborted/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDownloadCandidates(attachment, cdnBaseUrl) {
  const candidates = [];
  const seen = new Set();
  const directUrls = Array.isArray(attachment?.directUrls) ? attachment.directUrls : [];
  for (const directUrl of directUrls) {
    addCandidate(candidates, seen, directUrl);
  }

  const encryptedQueryParam = normalizeText(attachment?.mediaRef?.encryptQueryParam);
  if (encryptedQueryParam) {
    const normalizedCdnBaseUrl = String(cdnBaseUrl || "").replace(/\/+$/g, "");
    addCandidate(
      candidates,
      seen,
      `${normalizedCdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
    );

    const fileKey = normalizeText(attachment?.mediaRef?.fileKey);
    if (fileKey) {
      addCandidate(
        candidates,
        seen,
        `${normalizedCdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}&filekey=${encodeURIComponent(fileKey)}`
      );
    }
  }

  return candidates;
}

function addCandidate(candidates, seen, rawUrl) {
  const normalizedUrl = normalizeText(rawUrl);
  if (!normalizedUrl || seen.has(normalizedUrl)) {
    return;
  }
  seen.add(normalizedUrl);
  candidates.push(normalizedUrl);
}

function decodeAttachmentPayload(bytes, attachment, contentType) {
  const encryptType = Number(attachment?.mediaRef?.encryptType);
  const keyCandidates = buildAesKeyCandidates(attachment);
  if (encryptType !== 1 || keyCandidates.length === 0) {
    return bytes;
  }

  for (const key of keyCandidates) {
    try {
      return decryptAesEcb(bytes, key);
    } catch {
      // Try the next key encoding variant.
    }
  }

  if (looksLikePlainMedia(bytes, contentType)) {
    return bytes;
  }

  throw new Error("failed to decrypt attachment payload");
}

function buildAesKeyCandidates(attachment) {
  const candidates = [];
  const seen = new Set();
  const rawValues = [
    attachment?.mediaRef?.aesKeyHex,
    attachment?.mediaRef?.aesKey,
  ];

  for (const rawValue of rawValues) {
    const variants = decodeAesKeyVariants(rawValue);
    for (const variant of variants) {
      const signature = variant.toString("hex");
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      candidates.push(variant);
    }
  }

  return candidates;
}

function decodeAesKeyVariants(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return [];
  }

  const candidates = [];
  if (/^[0-9a-f]{32}$/i.test(normalized)) {
    candidates.push(Buffer.from(normalized, "hex"));
  }
  if (normalized.length === 16) {
    candidates.push(Buffer.from(normalized, "utf8"));
  }

  try {
    const decoded = Buffer.from(normalized, "base64");
    if (decoded.length === 16) {
      candidates.push(decoded);
    } else {
      const decodedText = decoded.toString("utf8").trim();
      if (/^[0-9a-f]{32}$/i.test(decodedText)) {
        candidates.push(Buffer.from(decodedText, "hex"));
      }
    }
  } catch {
    // Ignore invalid base64 variants.
  }

  return candidates.filter((candidate) => candidate.length === 16);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function looksLikePlainMedia(bytes, contentType) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return false;
  }

  if (contentType.startsWith("text/")) {
    return true;
  }

  return detectExtensionFromBuffer(bytes) !== "";
}

function buildTargetFileName({ attachment, plaintext, contentType, messageId }) {
  const sourceName = sanitizeFileName(attachment?.fileName || "");
  if (sourceName) {
    const existingExt = path.extname(sourceName);
    if (existingExt) {
      return sourceName;
    }

    const inferredExt = inferExtension({
      contentType,
      plaintext,
      kind: attachment?.kind,
    });
    return `${sourceName}${inferredExt}`;
  }

  const baseName = sanitizeFileName([
    attachment?.kind || "file",
    messageId || Date.now(),
    String((attachment?.index ?? 0) + 1),
  ].join("-"));
  const inferredExt = inferExtension({
    contentType,
    plaintext,
    kind: attachment?.kind,
  });
  return `${baseName || "attachment"}${inferredExt}`;
}

function inferExtension({ contentType, plaintext, kind }) {
  const contentTypeExt = extensionFromContentType(contentType);
  if (contentTypeExt) {
    return contentTypeExt;
  }

  const bufferExt = detectExtensionFromBuffer(plaintext);
  if (bufferExt) {
    return bufferExt;
  }

  if (kind === "image") {
    return ".png";
  }
  if (kind === "video") {
    return ".mp4";
  }
  return ".bin";
}

function extensionFromContentType(contentType) {
  const normalized = normalizeContentType(contentType);
  const map = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return map[normalized] || "";
}

function isImageAttachment({ kind, contentType, fileName }) {
  if (normalizeText(kind).toLowerCase() === "image") {
    return true;
  }
  if (normalizeContentType(contentType).startsWith("image/")) {
    return true;
  }
  const extension = path.extname(normalizeText(fileName)).toLowerCase();
  return extension === ".png"
    || extension === ".jpg"
    || extension === ".jpeg"
    || extension === ".gif"
    || extension === ".webp"
    || extension === ".bmp"
    || extension === ".svg";
}

function detectExtensionFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return "";
  }

  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return ".png";
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF]))) {
    return ".jpg";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "GIF8") {
    return ".gif";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return ".webp";
  }
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    return ".mp4";
  }
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return ".pdf";
  }
  return "";
}

function sanitizeFileName(value) {
  const parsed = path.parse(String(value || "").trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-"));
  const safeBaseName = parsed.name || "attachment";
  const safeExt = parsed.ext || "";
  return `${safeBaseName.slice(0, MAX_FILE_NAME_LENGTH)}${safeExt.slice(0, 16)}`;
}

async function writeUniqueFile(targetDir, fileName, plaintext) {
  await fs.mkdir(targetDir, { recursive: true });
  const parsed = path.parse(fileName);
  const baseName = parsed.name || "attachment";
  const extension = parsed.ext || "";
  for (let index = 0; index < 50; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = path.join(targetDir, `${baseName}${suffix}${extension}`);
    try {
      await fs.writeFile(candidate, plaintext, { flag: "wx" });
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  }

  throw new Error("unable to allocate a unique attachment file name");
}

async function ensureAttachmentNote({
  officePaths,
  dateFolder,
  absolutePath,
  fileName,
  attachment,
  contentType,
  receivedAt,
  messageText,
}) {
  const notesRoot = normalizeText(officePaths?.notesRoot);
  if (!notesRoot) {
    return "";
  }

  const noteDir = path.join(notesRoot, dateFolder);
  await fs.mkdir(noteDir, { recursive: true });
  const notePath = path.join(noteDir, `${path.parse(fileName).name}.md`);
  const noteBody = buildAttachmentNoteTemplate({
    absolutePath,
    fileName,
    notePath,
    attachment,
    contentType,
    receivedAt,
    messageText,
    workspaceRoot: officePaths.workspaceRoot,
  });

  try {
    await fs.writeFile(notePath, noteBody, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  return notePath;
}

async function appendAttachmentJournal({
  officePaths,
  absolutePath,
  noteAbsolutePath,
  attachment,
  contentType,
  receivedAt,
  messageId,
  sizeBytes,
  messageText,
}) {
  const journalFile = normalizeText(officePaths?.journalFile);
  if (!journalFile) {
    return;
  }

  const workspaceRoot = normalizeText(officePaths?.workspaceRoot);
  await fs.mkdir(path.dirname(journalFile), { recursive: true });
  const payload = {
    recorded_at: new Date().toISOString(),
    received_at: normalizeText(receivedAt),
    message_id: normalizeText(messageId),
    kind: normalizeText(attachment?.kind) || "file",
    source_file_name: normalizeText(attachment?.fileName),
    content_type: normalizeContentType(contentType),
    saved_file: absolutePath,
    saved_file_relative: workspaceRoot ? path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/") : "",
    note_file: normalizeText(noteAbsolutePath),
    note_file_relative: workspaceRoot && noteAbsolutePath
      ? path.relative(workspaceRoot, noteAbsolutePath).replace(/\\/g, "/")
      : "",
    size_bytes: Number(sizeBytes) || 0,
    user_text: normalizeText(messageText),
  };
  await fs.appendFile(journalFile, `${JSON.stringify(payload)}\n`, "utf8");
}

async function finalizeAttachmentNotes({
  attachments,
  assistantTextFinal = "",
  writebackResult = null,
  completedAt = "",
} = {}) {
  const explanation = normalizeText(assistantTextFinal);
  if (!explanation) {
    return { updated: 0, skipped: 0 };
  }

  let updated = 0;
  let skipped = 0;
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const notePath = normalizeText(attachment?.noteAbsolutePath);
    if (!notePath) {
      skipped += 1;
      continue;
    }
    try {
      const changed = await finalizeSingleAttachmentNote({
        notePath,
        attachment,
        explanation,
        writebackResult,
        completedAt,
      });
      if (changed) {
        updated += 1;
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { updated, skipped };
}

async function finalizeSingleAttachmentNote({
  notePath,
  attachment,
  explanation,
  writebackResult,
  completedAt,
}) {
  let existing = "";
  try {
    existing = await fs.readFile(notePath, "utf8");
  } catch {
    return false;
  }
  const recordId = normalizeText(
    writebackResult?.appended_record?.record_id
    || writebackResult?.appendedRecord?.record_id
    || writebackResult?.record_id
  );
  const recordPath = normalizeText(
    writebackResult?.appended_record?.path
    || writebackResult?.appendedRecord?.path
    || writebackResult?.path
  );
  const completed = normalizeText(completedAt) || new Date().toISOString();
  const savedFile = normalizeText(attachment?.relativePath || attachment?.absolutePath || attachment?.fileName);
  const shortSummary = firstParagraph(explanation).slice(0, MAX_AUTO_NOTE_SUMMARY_CHARS);
  const details = truncateText(explanation, MAX_AUTO_NOTE_DETAILS_CHARS);
  const sourceLines = [
    `auto_captured_at: ${completed}`,
    recordId ? `conversation_cache_record: ${recordId}` : "",
    recordPath ? `conversation_cache_path: ${recordPath}` : "",
    savedFile ? `saved_file_ref: ${savedFile}` : "",
  ].filter(Boolean);

  let next = existing;
  next = replacePendingSection(next, "Summary", [
    "Auto-captured from the assistant reply in the same attachment turn.",
    "",
    shortSummary,
  ].join("\n").trim());
  next = replacePendingSection(next, "Why It May Matter", [
    "This attachment was referenced by a normal WeChat turn and written back into the shared conversation basin.",
    "The text below preserves the front-stage interpretation so the file is not a silent blob if the raw image is unavailable later.",
    "",
    sourceLines.join("\n"),
  ].join("\n").trim());
  next = replacePendingSection(next, "Visible Text / Details", details);
  next = replacePendingSection(next, "Follow-up", [
    "If this attachment becomes long-term evidence, replace or refine this auto-captured note with a tighter human/agent-verified description after inspecting the raw file.",
  ].join("\n"));

  if (next === existing) {
    return false;
  }
  await fs.writeFile(notePath, next, "utf8");
  return true;
}

function buildAttachmentNoteTemplate({
  absolutePath,
  fileName,
  notePath,
  attachment,
  contentType,
  receivedAt,
  messageText,
  workspaceRoot,
}) {
  const savedRelative = workspaceRoot
    ? path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/")
    : fileName;
  const noteRelative = workspaceRoot
    ? path.relative(workspaceRoot, notePath).replace(/\\/g, "/")
    : path.basename(notePath);
  const parts = [
    "# Attachment Note",
    "",
    `- received_at: ${normalizeText(receivedAt) || new Date().toISOString()}`,
    `- kind: ${normalizeText(attachment?.kind) || "file"}`,
    `- content_type: ${normalizeContentType(contentType) || "unknown"}`,
    `- original_name: ${normalizeText(attachment?.fileName) || path.basename(absolutePath)}`,
    `- saved_file: ${savedRelative}`,
    `- note_file: ${noteRelative}`,
  ];

  const normalizedMessageText = normalizeText(messageText);
  if (normalizedMessageText) {
    parts.push(`- message_text: ${normalizedMessageText}`);
  }

  parts.push(
    "",
    "## Summary",
    "<pending>",
    "",
    "## Why It May Matter",
    "<pending>",
    "",
    "## Visible Text / Details",
    "<pending>",
    "",
    "## Follow-up",
    "<pending>",
    "",
  );
  return parts.join("\n");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeContentType(value) {
  return typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : "";
}

function replacePendingSection(markdown, title, replacement) {
  const safeReplacement = normalizeText(replacement);
  if (!safeReplacement) {
    return markdown;
  }
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(## ${escapedTitle}\\n)([\\s\\S]*?)(?=\\n## |\\n?$)`, "m");
  const match = markdown.match(pattern);
  if (!match) {
    return markdown;
  }
  const body = normalizeText(match[2]);
  if (body && body !== "<pending>") {
    return markdown;
  }
  return markdown.replace(pattern, `$1${safeReplacement}\n`);
}

function firstParagraph(value) {
  const paragraphs = normalizeText(value)
    .split(/\n{2,}/)
    .map((part) => normalizeText(part.replace(/^#+\s*/gm, "").replace(/\*\*/g, "")))
    .filter(Boolean);
  return paragraphs[0] || normalizeText(value);
}

function truncateText(value, maxChars) {
  const text = normalizeText(value);
  const limit = Math.max(1, Number(maxChars) || 1);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

module.exports = {
  finalizeAttachmentNotes,
  persistIncomingWeixinAttachments,
};

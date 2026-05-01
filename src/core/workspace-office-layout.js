const path = require("path");

const DEFAULT_WORKSPACE_INBOX_DIR = path.join("wechat", "inbox");
const DEFAULT_WORKSPACE_ATTACHMENT_NOTES_DIR = path.join("context", "attachment-notes");
const DEFAULT_WORKSPACE_ATTACHMENT_JOURNAL_FILE = path.join("context", "attachment-journal.jsonl");

function resolveWorkspaceOfficePaths({ workspaceRoot = "", config = {} } = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot) || normalizeText(config.workspaceRoot);
  const normalizedStateDir = normalizeText(config.stateDir);

  const inboxRoot = resolveManagedWorkspacePath({
    configuredPath: config.workspaceInboxDir,
    workspaceRoot: normalizedWorkspaceRoot,
    stateDir: normalizedStateDir,
    fallbackWorkspaceRelativePath: DEFAULT_WORKSPACE_INBOX_DIR,
    fallbackStateRelativePath: "inbox",
  });

  const notesRoot = resolveManagedWorkspacePath({
    configuredPath: config.workspaceAttachmentNotesDir,
    workspaceRoot: normalizedWorkspaceRoot,
    stateDir: normalizedStateDir,
    fallbackWorkspaceRelativePath: DEFAULT_WORKSPACE_ATTACHMENT_NOTES_DIR,
    fallbackStateRelativePath: "attachment-notes",
  });

  const journalFile = resolveManagedWorkspacePath({
    configuredPath: config.workspaceAttachmentJournalFile,
    workspaceRoot: normalizedWorkspaceRoot,
    stateDir: normalizedStateDir,
    fallbackWorkspaceRelativePath: DEFAULT_WORKSPACE_ATTACHMENT_JOURNAL_FILE,
    fallbackStateRelativePath: "attachment-journal.jsonl",
  });

  return {
    workspaceRoot: normalizedWorkspaceRoot,
    inboxRoot,
    notesRoot,
    journalFile,
  };
}

function resolveManagedWorkspacePath({
  configuredPath = "",
  workspaceRoot = "",
  stateDir = "",
  fallbackWorkspaceRelativePath = "",
  fallbackStateRelativePath = "",
}) {
  const normalizedConfiguredPath = normalizeText(configuredPath);
  if (normalizedConfiguredPath) {
    if (path.isAbsolute(normalizedConfiguredPath)) {
      return path.resolve(normalizedConfiguredPath);
    }
    if (workspaceRoot) {
      return path.join(workspaceRoot, normalizedConfiguredPath);
    }
    if (stateDir) {
      return path.join(stateDir, normalizedConfiguredPath);
    }
  }

  if (workspaceRoot && fallbackWorkspaceRelativePath) {
    return path.join(workspaceRoot, fallbackWorkspaceRelativePath);
  }

  if (stateDir && fallbackStateRelativePath) {
    return path.join(stateDir, fallbackStateRelativePath);
  }

  return "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  DEFAULT_WORKSPACE_ATTACHMENT_JOURNAL_FILE,
  DEFAULT_WORKSPACE_ATTACHMENT_NOTES_DIR,
  DEFAULT_WORKSPACE_INBOX_DIR,
  resolveWorkspaceOfficePaths,
};

const { spawn } = require("child_process");

class ClaudeCodeProcessClient {
  constructor({ command = "claude", cwd, env, model = "", permissionMode = "default", bare = false, appendSystemPrompt = "", disableVerbose = false, extraArgs = [], mcpConfigPaths = [], ipcServer = null, workspaceRoot = "" }) {
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.model = model;
    this.permissionMode = permissionMode;
    this.bare = bare;
    this.appendSystemPrompt = appendSystemPrompt;
    this.disableVerbose = disableVerbose;
    this.extraArgs = extraArgs;
    this.mcpConfigPaths = mcpConfigPaths;
    this.ipcServer = ipcServer;
    this.workspaceRoot = workspaceRoot;
    this.child = null;
    this.stdin = null;
    this.stdoutBuffer = "";
    this.listeners = new Set();
    this.pendingTurnId = "";
    this.sessionId = "";
    this.resumeSessionId = "";
    this.activeThreadId = "";
    this.assistantItemSequence = 0;
    this.alive = false;
    this.sessionWaiters = new Set();
    this.stderrTail = "";
    this.closingIntentionally = false;
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event, raw) {
    if (this.ipcServer) {
      this.ipcServer.broadcast({ type: "processEvent", event, raw });
    }
    for (const listener of this.listeners) {
      try {
        listener(event, raw);
      } catch {
        // ignore
      }
    }
  }

  async connect(resumeSessionId = "") {
    if (this.child) return;
    this.sessionId = "";
    this.resumeSessionId = isValidSessionId(resumeSessionId) ? resumeSessionId : "";
    // When resuming a ClaudeCode conversation, the bridge already knows the
    // canonical session id. Do not block WeChat delivery waiting for ClaudeCode
    // to echo the same id before the first streamed event arrives.
    this.sessionId = this.resumeSessionId;
    this.activeThreadId = this.resumeSessionId;
    const args = buildArgs({
      model: this.model,
      permissionMode: this.permissionMode,
      bare: this.bare,
      appendSystemPrompt: this.appendSystemPrompt,
      disableVerbose: this.disableVerbose,
      extraArgs: this.extraArgs,
      mcpConfigPaths: this.mcpConfigPaths,
      resumeSessionId,
    });
    const mcpLabel = this.mcpConfigPaths.length
      ? this.mcpConfigPaths.join(",")
      : "(none)";
    console.log(
      `[claudecode-runtime] launching command=${this.command} cwd=${this.cwd} mcp_config=${mcpLabel}`
    );
    const child = spawn(this.command, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;
    this.stdin = child.stdin;
    this.alive = true;

    child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        this.handleLine(line.trim());
      }
    });

    child.stderr.on("data", (chunk) => {
      this.handleStderrText(chunk.toString("utf8"));
    });

    child.on("error", (err) => {
      this.rejectSessionWaiters(err);
      const sessionId = this.activeThreadId || this.sessionId;
      const turnId = this.pendingTurnId;
      const intentional = this.closingIntentionally;
      this.alive = false;
      this.child = null;
      this.stdin = null;
      this.emit({
        type: turnId && !intentional ? "process.error" : "process.closed",
        error: err.message,
        stderrTail: this.stderrTail,
        sessionId,
        turnId,
        intentional,
      }, null);
    });

    child.on("close", (code, signal) => {
      this.rejectSessionWaiters(new Error(`claudecode process closed with code ${code ?? "unknown"}`));
      const sessionId = this.activeThreadId || this.sessionId;
      const turnId = this.pendingTurnId;
      const stderrTail = this.stderrTail;
      const intentional = this.closingIntentionally;
      this.alive = false;
      this.child = null;
      this.stdin = null;
      this.emit({
        type: turnId && !intentional ? "process.close" : "process.closed",
        code,
        signal,
        stderrTail,
        sessionId,
        turnId,
        intentional,
      }, null);
    });
  }

  handleLine(line) {
    if (!line) return;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const eventType = raw?.type;
    switch (eventType) {
      case "system":
        if (raw.session_id) {
          if (isPendingThreadId(this.activeThreadId)) {
            this.activeThreadId = raw.session_id;
          }
          this.sessionId = raw.session_id;
          this.resumeSessionId = "";
          this.resolveSessionWaiters(raw.session_id);
          this.emit({ type: "session.id", sessionId: raw.session_id }, raw);
        }
        break;
      case "assistant":
        this.handleAssistant(raw);
        break;
      case "user":
        this.handleUser(raw);
        break;
      case "result":
        this.handleResult(raw);
        break;
      case "control_request":
        this.handleControlRequest(raw);
        break;
      case "control_cancel_request":
        break;
    }
  }

  handleStderrText(value) {
    const text = String(value || "").trim();
    if (!text) return;
    console.error(`[claudecode-runtime] stderr: ${text}`);
    if (!isPotentiallySensitive(text)) {
      this.stderrTail = appendTextTail(this.stderrTail, text);
      if (this.ipcServer) {
        this.ipcServer.broadcast({ type: "stderr", text });
      }
    }
    const failure = classifyClaudeCodeRuntimeFailure(text);
    if (failure && this.pendingTurnId) {
      this.failActiveTurn(failure, null);
    }
  }

  handleAssistant(raw) {
    const usage = raw?.message?.usage;
    if (usage && typeof usage === "object") {
      this.emit({
        type: "context.updated",
        usage,
        turnId: this.pendingTurnId,
        sessionId: this.activeThreadId || this.sessionId,
      }, raw);
    }
    const content = raw?.message?.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const itemType = item.type;
      if (itemType === "text" && typeof item.text === "string" && item.text) {
        this.emit({
          type: "reply.completed",
          itemId: nextAssistantItemId(this),
          text: item.text.trim(),
          turnId: this.pendingTurnId,
          sessionId: this.activeThreadId || this.sessionId,
        }, raw);
      } else if (itemType === "tool_use") {
        const toolName = typeof item.name === "string" ? item.name : "";
        if (toolName === "AskUserQuestion") continue;
        this.emit({
          type: "tool.use",
          toolName,
          input: item.input || {},
          turnId: this.pendingTurnId,
          sessionId: this.activeThreadId || this.sessionId,
        }, raw);
      } else if (itemType === "thinking" && typeof item.thinking === "string" && item.thinking) {
        this.emit({
          type: "thinking",
          text: item.thinking.trim(),
          turnId: this.pendingTurnId,
          sessionId: this.activeThreadId || this.sessionId,
        }, raw);
      }
    }
  }

  handleUser(raw) {
    const content = raw?.message?.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "tool_result") {
        const isError = Boolean(item.is_error);
        const resultText = typeof item.content === "string" ? item.content : "";
        this.emit({
          type: "tool.result",
          toolResult: resultText,
          isError,
          turnId: this.pendingTurnId,
          sessionId: this.activeThreadId || this.sessionId,
        }, raw);
      }
    }
  }

  handleResult(raw) {
    if (raw.session_id) {
      this.sessionId = raw.session_id;
      this.resumeSessionId = "";
    }
    const resultText = typeof raw.result === "string" ? raw.result.trim() : "";
    const failure = classifyClaudeCodeRuntimeFailure(resultText);
    if (failure) {
      this.failActiveTurn(failure, raw);
      return;
    }
    this.emit({
      type: "turn.completed",
      turnId: this.pendingTurnId,
      sessionId: this.activeThreadId || this.sessionId,
      text: resultText,
    }, raw);
    this.pendingTurnId = "";
    this.activeThreadId = "";
    this.assistantItemSequence = 0;
  }

  handleControlRequest(raw) {
    const request = raw?.request || {};
    if (request.subtype !== "can_use_tool") return;
    this.emit({
      type: "approval.requested",
      requestId: raw.request_id,
      toolName: request.tool_name,
      input: request.input,
      sessionId: this.activeThreadId || this.sessionId,
      turnId: this.pendingTurnId,
    }, raw);
  }

  failActiveTurn(failure, raw) {
    if (!failure) {
      return false;
    }
    const turnId = this.pendingTurnId;
    const sessionId = this.activeThreadId || this.sessionId || this.resumeSessionId;
    this.pendingTurnId = "";
    this.activeThreadId = "";
    this.assistantItemSequence = 0;
    this.emit({
      type: "turn.failed",
      turnId,
      sessionId,
      text: failure.text,
      reason: failure.reason,
    }, raw);
    this.closeAfterFatalRuntimeFailure(failure.reason);
    return true;
  }

  closeAfterFatalRuntimeFailure(reason = "") {
    if (!this.child) {
      return;
    }
    console.warn(
      `[claudecode-runtime] closing process after fatal runtime failure reason=${reason || "runtime_failure"}`
    );
    this.close().catch((error) => {
      console.error(`[claudecode-runtime] failed to close process after fatal runtime failure: ${error.message}`);
    });
  }

  async sendUserMessage({ text, threadId }) {
    if (!this.alive || !this.stdin) {
      throw new Error("claudecode process not running");
    }
    this.pendingTurnId = `turn-${Date.now()}`;
    this.activeThreadId = threadId || this.sessionId;
    this.assistantItemSequence = 0;
    if (this.ipcServer) {
      this.ipcServer.broadcast({
        type: "inboundMessage",
        workspaceRoot: this.workspaceRoot,
        text,
      });
    }
    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content: sanitizeTextForClaudeJson(text) },
    });
    this.stdin.write(payload + "\n");
    this.emit({
      type: "turn.started",
      turnId: this.pendingTurnId,
      sessionId: this.activeThreadId,
    }, null);
  }

  async sendResponse(requestId, { decision }) {
    if (!this.alive || !this.stdin) {
      throw new Error("claudecode process not running");
    }
    const behavior = decision === "accept" ? "allow" : "deny";
    const response = behavior === "allow"
      ? { behavior: "allow", updatedInput: {} }
      : { behavior: "deny", message: "The user denied this tool use. Stop and wait for the user's instructions." };
    const payload = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response,
      },
    });
    this.stdin.write(payload + "\n");
  }

  async waitForSessionId({ timeoutMs = 5000 } = {}) {
    if (this.sessionId) {
      return this.sessionId;
    }
    if (!this.alive) {
      throw new Error("claudecode process not running");
    }
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
    return await new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        this.sessionWaiters.delete(entry);
        reject(new Error("timed out waiting for claudecode session id"));
      }, timeout);
      this.sessionWaiters.add(entry);
    });
  }

  async close() {
    if (!this.child) return;
    this.closingIntentionally = true;
    if (this.stdin && !this.stdin.destroyed) {
      this.stdin.end();
    }
    if (this.child && !this.child.killed) {
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 2000)),
        new Promise((resolve) => this.child.once("close", resolve)),
      ]);
    }
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 3000)),
        new Promise((resolve) => this.child.once("close", resolve)),
      ]);
    }
    if (this.child && !this.child.killed) {
      this.child.kill("SIGKILL");
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 1000)),
        new Promise((resolve) => this.child.once("close", resolve)),
      ]);
    }
    this.alive = false;
    this.child = null;
    this.stdin = null;
    this.sessionId = "";
    this.resumeSessionId = "";
    this.activeThreadId = "";
    this.pendingTurnId = "";
    this.rejectSessionWaiters(new Error("claudecode process closed"));
  }

  resolveSessionWaiters(sessionId) {
    if (!this.sessionWaiters.size) {
      return;
    }
    for (const entry of this.sessionWaiters) {
      clearTimeout(entry.timer);
      entry.resolve(sessionId);
    }
    this.sessionWaiters.clear();
  }

  rejectSessionWaiters(error) {
    if (!this.sessionWaiters.size) {
      return;
    }
    for (const entry of this.sessionWaiters) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.sessionWaiters.clear();
  }
}

function buildArgs({ model, permissionMode, bare = false, appendSystemPrompt = "", disableVerbose, extraArgs, mcpConfigPaths, resumeSessionId }) {
  const args = [
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--permission-prompt-tool", "stdio",
  ];
  if (bare) {
    args.push("--bare");
  }
  if (!disableVerbose) {
    args.push("--verbose");
  }
  if (permissionMode && permissionMode !== "default") {
    args.push("--permission-mode", permissionMode);
  }
  if (resumeSessionId && isValidSessionId(resumeSessionId)) {
    args.push("--resume", resumeSessionId);
  }
  if (model) {
    args.push("--model", model);
  }
  if (appendSystemPrompt) {
    args.push("--append-system-prompt", appendSystemPrompt);
  }
  if (Array.isArray(mcpConfigPaths)) {
    for (const configPath of mcpConfigPaths) {
      if (typeof configPath === "string" && configPath.trim()) {
        args.push("--mcp-config", configPath.trim());
      }
    }
  }
  if (Array.isArray(extraArgs)) {
    const safe = extraArgs.filter((arg) =>
      typeof arg === "string" && arg.length > 0 && !/^-[ce]\b/i.test(arg)
    );
    args.push(...safe);
  }
  return args;
}

function isValidSessionId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
}

const SENSITIVE_KEYWORDS = /\b(?:key|token|secret|password|credential|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\b/i;
const SENSITIVE_PATTERNS = /\b(?:sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9_\-]{20,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36})\b/i;

function isPotentiallySensitive(text) {
  return SENSITIVE_KEYWORDS.test(text) || SENSITIVE_PATTERNS.test(text);
}

function appendTextTail(existing, next, maxLength = 2000) {
  const joined = [String(existing || "").trim(), String(next || "").trim()]
    .filter(Boolean)
    .join("\n");
  if (joined.length <= maxLength) {
    return joined;
  }
  return joined.slice(joined.length - maxLength);
}

function sanitizeTextForClaudeJson(value) {
  const text = String(value || "");
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        out += text[index] + text[index + 1];
        index += 1;
      } else {
        out += "\uFFFD";
      }
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) {
      out += "\uFFFD";
      continue;
    }
    out += text[index];
  }
  return out;
}

function classifyClaudeCodeRuntimeFailure(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  if (/\bdiagnostics\.previous_message_id\b/i.test(text) || /\bprevious_message_id\b[\s\S]{0,160}\bprior\s+\/v1\/messages\s+response\b/i.test(text)) {
    return { reason: "stale_resume_session", text };
  }
  if (/^prompt is too long\b/i.test(text) || /\bprompt is too long\b/i.test(text)) {
    return { reason: "prompt_too_long", text };
  }
  if (/\bapi error:\s*(?:4\d\d|5\d\d)\b/i.test(text)) {
    return { reason: "api_error", text };
  }
  if (/\binvalid_request_error\b/i.test(text)) {
    return { reason: "invalid_request_error", text };
  }
  if (/\brequest body is not valid json\b/i.test(text)) {
    return { reason: "invalid_json", text };
  }
  if (/\bno low surrogate\b/i.test(text) || /\blone surrogate\b/i.test(text)) {
    return { reason: "invalid_surrogate", text };
  }
  return null;
}

module.exports = {
  ClaudeCodeProcessClient,
  buildArgs,
  sanitizeTextForClaudeJson,
  classifyClaudeCodeRuntimeFailure,
};

function isPendingThreadId(threadId) {
  return /^pending-\d+$/u.test(String(threadId || "").trim());
}

function nextAssistantItemId(client) {
  const turnId = String(client?.pendingTurnId || "").trim() || "turn";
  client.assistantItemSequence = Number(client.assistantItemSequence || 0) + 1;
  return `item-${turnId}-${client.assistantItemSequence}`;
}

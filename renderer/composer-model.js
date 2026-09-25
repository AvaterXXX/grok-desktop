(function initComposerModel(global) {
  const SESSION_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  function fileBasename(value) {
    const normalized = String(value || "").replace(/\\/g, "/");
    const index = normalized.lastIndexOf("/");
    return (index >= 0 ? normalized.slice(index + 1) : normalized) || "文件";
  }

  function looksLikeImageFile(file) {
    if (!file) return false;
    if (file.isImage === true) return true;
    const name = String(file.name || file.path || file.key || "");
    return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
  }

  function parseAttachText(text) {
    const raw = String(text || "");
    const match = raw.match(/^附加\s*(\d+)\s*个文件[：:]\s*\n?([\s\S]*)$/);
    if (!match) return null;
    const files = [];
    for (const line of match[2].split(/\n/)) {
      const filePath = line.replace(/^[·•\-\s]+/, "").trim();
      if (filePath) files.push({ path: filePath, name: fileBasename(filePath) });
    }
    return files.length ? files : null;
  }

  function buildPromptWithFiles(text, files) {
    if (!files?.length) return text || "";
    const parts = [];
    for (const file of files) {
      if (file.preview) parts.push(`<file path="${file.path}">\n${file.preview}\n</file>`);
      else parts.push(`请参考文件：\`${file.path}\``);
    }
    if (text) parts.push(text);
    return parts.join("\n\n");
  }

  function unwrapGoalWrap(text, displayText) {
    const raw = String(text || "");
    const shown = String(displayText || "").trim();
    const match = raw.match(/^\/goal\s+([\s\S]+)$/i);
    if (match && shown && shown !== raw) return shown;
    if (match) return match[1].trim();
    return raw;
  }

  function parseCallSession(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;
    const slash = raw.match(
      /^\/(?:call|send-to|invoke)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+([\s\S]+)$/i,
    );
    if (slash) return { sessionId: slash[1], text: slash[2].trim() };
    const bare = raw.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (bare) return { sessionId: bare[1], text: "", bare: true };
    return null;
  }

  function formatWaitClock(ms) {
    const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    if (minutes >= 60) return `${Math.floor(minutes / 60)}小时 ${minutes % 60}分钟`;
    return minutes ? `${minutes}分钟 ${rest}秒` : `${rest}秒`;
  }

  function pickSendErrorText(value, depth = 0) {
    if (value == null || depth > 4) return "";
    if (typeof value === "string") {
      const text = value.trim();
      return !text || /^\[object Object\]/i.test(text) ? "" : text;
    }
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value !== "object") return "";
    for (const key of ["message", "error", "detail", "reason", "data"]) {
      const text = pickSendErrorText(value[key], depth + 1);
      if (text) return text;
    }
    return "";
  }

  /** Memory draft wins, including an explicit empty box. Disk fills only the unset case. */
  function resolveComposerDraft(memoryDraft, diskDraft) {
    if (typeof memoryDraft === "string") return memoryDraft;
    if (typeof diskDraft === "string") return diskDraft;
    return "";
  }

  function formatSendError(error) {
    let message = pickSendErrorText(error) || "";
    const invoke = message.match(
      /Error invoking remote method '[^']+':\s*(?:Error:\s*)?([\s\S]+)$/i,
    );
    if (invoke) message = invoke[1].trim();
    if (/图片太大|CLI 吃不下/.test(message)) return "图片太大，CLI 吃不下。请换小图或只发文字。";
    if (/CLI 进程意外退出|CLI 进程退出且重连失败/.test(message)) return message;
    if (/Grok process exited|Grok process not running/i.test(message)) {
      return "CLI 进程意外退出。点发送会自动重连；若这轮没回完，再说「继续」。";
    }
    if (/Grok Build is coming soon|don't have access now/i.test(message)) {
      return "Grok 4.6 还没开通（Grok Build 即将推出）。先切到 4.5 就能发。";
    }
    if (/ACP timeout:\s*session\/prompt/i.test(message)) return "这轮等太久，CLI 还没结束";
    if (/ACP timeout/i.test(message)) return "CLI 超时没回";
    if (!message || /\[object Object\]/i.test(message)) return "发送失败（无详细错误）";
    return message;
  }

  global.GrokComposerModel = {
    SESSION_ID_RE,
    buildPromptWithFiles,
    fileBasename,
    formatSendError,
    formatWaitClock,
    looksLikeImageFile,
    parseAttachText,
    parseCallSession,
    pickSendErrorText,
    resolveComposerDraft,
    unwrapGoalWrap,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

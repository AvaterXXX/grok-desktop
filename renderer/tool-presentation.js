(function (global, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.GrokToolPresentation = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const DEFAULT_PREVIEW_LENGTH = 96;

  function looksLikeCompact(raw) {
    const value = String(raw || "");
    return /session[_-]?compact|context[_-]?compact|compact(?:ing|ed|ion)?\s+context|\/compact\b|compress(?:ing|ed)?\s+(?:the\s+)?context|summariz(?:e|ing|ed)\s+(?:the\s+)?context|压缩(?:上下文|历史|对话|记忆)|正在压缩上下文/i.test(
      value,
    );
  }

  function isTerminalToolStatus(status) {
    return /complete|ok|success|failed|error|cancel|done|reject|denied/.test(
      String(status || "").toLowerCase(),
    );
  }

  function diffStatusPresentation(status, locale = "zh") {
    const value = String(status || "running").toLowerCase();
    const cancelled = /cancel|abort|stop/.test(value);
    const failed = /fail|error|reject|denied/.test(value);
    const done = /complete|ok|success|done/.test(value);
    const running = !cancelled && !failed && !done;
    const en = locale === "en";
    return {
      value,
      running,
      done,
      failed: cancelled || failed,
      label: cancelled ? (en ? "Cancelled" : "已取消") : failed ? (en ? "Failed" : "失败") : "",
    };
  }

  function defaultToolGroupExpanded({ total = 0, running = 0, failed = 0 } = {}) {
    if (total < 2) return true;
    return running > 0 || failed > 0;
  }

  function stringifyDetail(value) {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function buildToolDetailText(payload = {}, maxLength = 6000) {
    const parts = [];
    if (payload.kind) parts.push(`kind: ${payload.kind}`);
    if (payload.rawInput !== undefined && payload.rawInput !== null && payload.rawInput !== "") {
      parts.push(stringifyDetail(payload.rawInput));
    }
    if (payload.rawOutput !== undefined && payload.rawOutput !== null && payload.rawOutput !== "") {
      parts.push(`--- output ---\n${stringifyDetail(payload.rawOutput)}`);
    }
    return parts.join("\n\n").slice(0, maxLength);
  }

  function toolPreviewLine(detail, maxLength = DEFAULT_PREVIEW_LENGTH) {
    if (!detail) return "";
    const line =
      String(detail)
        .split(/\r?\n/)
        .find((item) => item.trim()) || "";
    const compact = line.replace(/\s+/g, " ").trim();
    if (!compact) return "";
    const cleaned = compact.replace(/^kind:\s*/i, "").trim() || compact;
    return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
  }

  function extractToolTarget(payload, locale = "zh") {
    const raw = payload?.rawInput;
    if (raw == null) {
      const title = String(payload?.title || "");
      const match = title.match(/\s(\S+\.\w{1,8})\s*$/);
      return match ? match[1] : "";
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (/^[{[]/.test(trimmed)) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object")
            return extractToolTarget({ ...payload, rawInput: parsed }, locale);
        } catch {
          return "";
        }
      }
      const line = raw.split(/\r?\n/).find((item) => item.trim()) || raw;
      return line.replace(/\s+/g, " ").trim().slice(0, 160);
    }
    if (typeof raw === "object") {
      const target =
        raw.path ||
        raw.file_path ||
        raw.filePath ||
        raw.target_file ||
        raw.target_directory ||
        raw.directory ||
        raw.command ||
        raw.cmd ||
        raw.query ||
        raw.pattern ||
        raw.glob ||
        raw.url ||
        raw.uri ||
        "";
      if (target) return String(target).replace(/\s+/g, " ").trim().slice(0, 160);
      if (Array.isArray(raw.todos))
        return locale === "en" ? `${raw.todos.length} items` : `${raw.todos.length} 项`;
      if (Array.isArray(raw.task_ids))
        return locale === "en" ? `${raw.task_ids.length} tasks` : `${raw.task_ids.length} 个任务`;
      return "";
    }
    return String(raw).slice(0, 120);
  }

  function shortTargetLabel(target) {
    if (!target) return "";
    const value = String(target).trim();
    if (value.includes("/") || value.includes("\\")) {
      const parts = value.replace(/\\/g, "/").split("/").filter(Boolean);
      if (parts.length >= 2) {
        const base = parts.at(-1);
        const short = `${parts.at(-2)}/${base}`;
        return short.length > 48 ? `…${base.slice(-40)}` : short;
      }
    }
    return value.length > 56 ? `${value.slice(0, 54)}…` : value;
  }

  function normalizeDiffPath(value) {
    const raw = String(value || "")
      .trim()
      .replace(/\\/g, "/");
    if (!raw) return "";
    const prefix = raw.startsWith("//") ? "//" : raw.startsWith("/") ? "/" : "";
    const parts = raw.replace(/^\/+/, "").split(/\/+/).filter(Boolean);
    const settled = [];
    for (const part of parts) {
      if (part === ".") continue;
      if (part === ".." && settled.length && settled.at(-1) !== "..") settled.pop();
      else settled.push(part);
    }
    const normalized = prefix + settled.join("/");
    // Grok Desktop is shipped for Windows, whose normal file systems are
    // case-insensitive. This also merges slash variants from different tools.
    return normalized.replace(/\/$/, "").toLocaleLowerCase("en-US");
  }

  function diffPathLabel(change = {}) {
    const relative = String(change.relativePath || "")
      .trim()
      .replace(/\\/g, "/");
    const absolute = String(change.path || "")
      .trim()
      .replace(/\\/g, "/");
    const basename = String(change.basename || "").trim();
    if (relative && !/^(?:[a-z]:\/|\/\/|\/)/i.test(relative)) {
      return relative.replace(/^\.\//, "").replace(/\/+/g, "/");
    }
    const parts = (absolute || relative).split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts.at(-2)}/${parts.at(-1)}`;
    return basename || parts.at(-1) || relative || absolute;
  }

  function aggregateDiffStatus(payloads = []) {
    const statuses = payloads.map((item) => String(item?.status || "running").toLowerCase());
    if (statuses.some((status) => /fail|error|reject|denied|cancel|abort|stop/.test(status))) {
      return "failed";
    }
    if (statuses.some((status) => !isTerminalToolStatus(status))) return "running";
    return statuses.length ? "completed" : "running";
  }

  function humanizeToolActivity(payload = {}, locale = "zh") {
    const status = String(payload.status || "running").toLowerCase();
    const running = !isTerminalToolStatus(status);
    const kind = String(payload.kind || "").toLowerCase();
    const titleRaw = String(payload.title || "");
    const displayTitle = titleRaw.replace(/\s*[{[][\s\S]*$/, "").trim();
    const blob = `${kind} ${titleRaw}`.toLowerCase();
    const target = shortTargetLabel(extractToolTarget(payload, locale));
    const en = locale === "en";
    let verbRun;
    let verbDone;
    let emoji = "⚙";
    if (looksLikeCompact(kind) || looksLikeCompact(titleRaw)) {
      verbRun = en ? "Compacting context" : "正在压缩上下文";
      verbDone = en ? "Context compacted" : "已压缩上下文";
      emoji = "▣";
    } else if (/read|view|cat|open_file|read_file|get_file/.test(blob)) {
      verbRun = en ? "Reading" : "正在阅读";
      verbDone = en ? "Read" : "已阅读";
      emoji = "📖";
    } else if (
      /write|edit|create|str_replace|search_replace|apply_patch|patch|update_file|write_file/.test(
        blob,
      )
    ) {
      verbRun = en ? "Editing" : "正在修改";
      verbDone = en ? "Edited" : "已修改";
      emoji = "✎";
    } else if (/bash|shell|terminal|exec|command|run_terminal|run_command|powershell/.test(blob)) {
      verbRun = en ? "Running command" : "正在运行命令";
      verbDone = en ? "Command done" : "命令完成";
      emoji = "⌘";
    } else if (/grep|search|find|glob|rg|list_dir|listdir|ls\b/.test(blob)) {
      verbRun = en ? "Searching" : "正在搜索";
      verbDone = en ? "Search done" : "搜索完成";
      emoji = "⌕";
    } else if (/web|fetch|browse|http|download/.test(blob)) {
      verbRun = en ? "Fetching web" : "正在联网查询";
      verbDone = en ? "Fetch done" : "联网完成";
      emoji = "🌐";
    } else if (/diff|git/.test(blob)) {
      verbRun = en ? "Inspecting changes" : "正在查看变更";
      verbDone = en ? "Inspected" : "已查看变更";
      emoji = "±";
    } else if (/think|reason/.test(blob)) {
      verbRun = en ? "Thinking" : "正在思考";
      verbDone = en ? "Thought" : "思考完成";
      emoji = "…";
    } else {
      verbRun = en ? "Using tool" : "正在调用工具";
      verbDone = en ? "Tool done" : "工具完成";
    }
    const verb = running ? verbRun : verbDone;
    const title = target
      ? `${verb} · ${target}`
      : displayTitle
        ? `${verb} · ${displayTitle}`
        : verb;
    return {
      running,
      title,
      line: `${emoji} ${title}`,
      sub: toolPreviewLine(buildToolDetailText(payload)),
      verb,
      target,
      emoji,
    };
  }

  return {
    buildToolDetailText,
    aggregateDiffStatus,
    defaultToolGroupExpanded,
    diffPathLabel,
    diffStatusPresentation,
    extractToolTarget,
    humanizeToolActivity,
    isTerminalToolStatus,
    looksLikeCompact,
    normalizeDiffPath,
    shortTargetLabel,
    toolPreviewLine,
  };
});

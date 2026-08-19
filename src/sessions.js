const fs = require("fs");
const path = require("path");
const { defaultCwd, homeDir } = require("./platform");

function grokHome() {
  return process.env.GROK_HOME || path.join(homeDir(), ".grok");
}

function sessionsRoot() {
  return path.join(grokHome(), "sessions");
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block) return "";
      if (typeof block === "string") return block;
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Prefer <user_query> body; strip bulky system wrappers. */
function cleanUserText(text) {
  if (!text) return "";
  let t = text;
  const m = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (m) t = m[1];
  t = t.replace(/<user_info>[\s\S]*?<\/user_info>/gi, "");
  t = t.replace(
    /<system[-_]reminder(?:\s[^>]*)?>[\s\S]*?<\/system[-_]reminder>/gi,
    "",
  );
  t = t.replace(/<\/?[a-zA-Z_][\w:-]*(?:\s[^>]*)?>/g, " ");
  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function truncate(text, max = 4000) {
  if (!text || text.length <= max) return text || "";
  return text.slice(0, max) + "\n…";
}

/** Internal sub-agent traces are not restorable as normal user sessions. */
function isUserVisibleSession(data) {
  const kind = String(data?.session_kind || "").trim().toLowerCase();
  return !kind.startsWith("subagent");
}

/**
 * Walk ~/.grok/sessions for summary.json files.
 * Returns newest-first list.
 */
function listSessions({ limit = 200, includeInternal = false } = {}) {
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return [];

  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // skip sqlite etc
        if (ent.name === "session_search.sqlite" || ent.name.endsWith(".sqlite")) continue;
        stack.push(full);
        continue;
      }
      if (ent.name !== "summary.json") continue;
      const data = safeReadJson(full);
      if (!data?.info?.id) continue;
      if (!includeInternal && !isUserVisibleSession(data)) continue;
      const title =
        data.generated_title ||
        data.session_summary ||
        data.info.id.slice(0, 8);
      out.push({
        id: data.info.id,
        cwd: data.info.cwd || null,
        title: String(title).replace(/\s+/g, " ").trim(),
        summary: (data.session_summary || "").slice(0, 200),
        createdAt: data.created_at || null,
        updatedAt: data.updated_at || data.last_active_at || null,
        model: data.current_model_id || null,
        numMessages: data.num_chat_messages ?? data.num_messages ?? 0,
        dir: path.dirname(full),
      });
    }
  }

  out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return out.slice(0, limit);
}

function reasoningSummaryText(row) {
  const s = row && row.summary;
  if (typeof s === "string") return s.trim();
  if (!Array.isArray(s)) return "";
  return s
    .map((item) => (typeof item === "string" ? item : item && item.text) || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * Load a conversation preview: user / thought / tool / assistant.
 * Tails last ~2MB so huge sessions stay cheap. Does not replay ACP streams.
 */
function loadHistoryPreview(sessionDir, { maxMessages = 500, maxChars = 24000, maxBytes = 2 * 1024 * 1024 } = {}) {
  const file = path.join(sessionDir, "chat_history.jsonl");
  if (!fs.existsSync(file)) return [];

  let raw;
  try {
    const st = fs.statSync(file);
    if (st.size <= maxBytes) {
      raw = fs.readFileSync(file, "utf8");
    } else {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
      fs.closeSync(fd);
      raw = buf.toString("utf8");
      const nl = raw.indexOf("\n");
      if (nl >= 0) raw = raw.slice(nl + 1);
    }
  } catch {
    return [];
  }

  const messages = [];
  const toolIndex = new Map();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const type = row.type || row.role;
    if (type === "system") continue;
    if (type === "user") {
      if (row.synthetic_reason) continue;
      const text = truncate(cleanUserText(extractTextContent(row.content)), maxChars);
      if (text) messages.push({ role: "user", text });
    } else if (type === "reasoning" || type === "thought") {
      const text = truncate(reasoningSummaryText(row), 2000);
      if (text) messages.push({ role: "thought", kind: "thought", text });
    } else if (type === "assistant" || type === "model") {
      const calls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
      for (const c of calls) {
        if (!c) continue;
        const id = c.id || c.tool_call_id || c.toolCallId;
        const name = c.name || c.toolName || "工具";
        const item = {
          role: "tool",
          kind: "tool",
          toolCallId: id,
          title: name,
          kindName: name,
          status: "completed",
          rawInput: c.arguments || c.input,
          text: name,
        };
        messages.push(item);
        if (id) toolIndex.set(id, messages.length - 1);
      }
      const text = truncate(extractTextContent(row.content).trim(), maxChars);
      if (text) messages.push({ role: "assistant", text });
    } else if (type === "tool_result" || type === "tool") {
      const id = row.tool_call_id || row.toolCallId;
      const detail = truncate(
        typeof row.content === "string" ? row.content : extractTextContent(row.content),
        1200,
      );
      if (id && toolIndex.has(id)) {
        const item = messages[toolIndex.get(id)];
        item.detail = detail;
        item.rawOutput = detail;
        item.status = "completed";
      } else if (detail) {
        messages.push({
          role: "tool",
          kind: "tool",
          toolCallId: id,
          title: "工具",
          status: "completed",
          detail,
          rawOutput: detail,
          text: detail.slice(0, 80),
        });
      }
    }
  }

  if (messages.length > maxMessages) return messages.slice(-maxMessages);
  return messages;
}

function findSession(sessionId) {
  if (!sessionId) return null;
  // Fast path: walk only matching id folder names
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(dir, ent.name);
      if (ent.name === sessionId) {
        const summary = path.join(full, "summary.json");
        if (fs.existsSync(summary)) {
          const data = safeReadJson(summary);
          if (data?.info?.id) {
            return {
              id: data.info.id,
              cwd: data.info.cwd || null,
              title:
                data.generated_title ||
                data.session_summary ||
                data.info.id.slice(0, 8),
              summary: data.session_summary || "",
              createdAt: data.created_at || null,
              updatedAt: data.updated_at || data.last_active_at || null,
              model: data.current_model_id || null,
              numMessages: data.num_chat_messages ?? data.num_messages ?? 0,
              dir: full,
            };
          }
        }
      }
      stack.push(full);
    }
  }
  return listSessions({ limit: 5000 }).find((s) => s.id === sessionId) || null;
}

/** Ensure a session appears in the sidebar immediately after create. */
function ensureSessionSummary({ id, cwd, title }) {
  if (!id) throw new Error("missing session id");
  const workDir = cwd || defaultCwd();
  const group = encodeURIComponent(workDir);
  const dir = path.join(sessionsRoot(), group, id);
  fs.mkdirSync(dir, { recursive: true });
  const summaryPath = path.join(dir, "summary.json");
  const now = new Date().toISOString();
  let data = safeReadJson(summaryPath) || {};
  data.info = { id, cwd: workDir, ...(data.info || {}) };
  data.generated_title = title || data.generated_title || "新对话";
  data.session_summary = data.session_summary || data.generated_title;
  data.created_at = data.created_at || now;
  data.updated_at = now;
  data.last_active_at = now;
  data.num_messages = data.num_messages || 0;
  data.num_chat_messages = data.num_chat_messages || 0;
  fs.writeFileSync(summaryPath, JSON.stringify(data, null, 2), "utf8");
  return {
    id,
    cwd: workDir,
    title: data.generated_title,
    summary: data.session_summary,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    model: data.current_model_id || null,
    numMessages: data.num_chat_messages || 0,
    dir,
  };
}

function renameSession(sessionId, title) {
  const s = findSession(sessionId);
  if (!s) throw new Error("会话不存在");
  const summaryPath = path.join(s.dir, "summary.json");
  const data = safeReadJson(summaryPath);
  if (!data) throw new Error("无法读取会话摘要");
  const t = String(title || "").trim();
  if (!t) throw new Error("标题不能为空");
  const now = new Date().toISOString();
  data.generated_title = t;
  data.session_summary = t;
  data.updated_at = now;
  data.last_active_at = now;
  fs.writeFileSync(summaryPath, JSON.stringify(data, null, 2), "utf8");
  return { ...s, title: t, summary: t, updatedAt: now };
}

/** Drop last real user turn and everything after it from chat_history.jsonl. */
function rewindLastUserTurn(sessionId) {
  const s = findSession(sessionId);
  if (!s) return { ok: false, error: "not found" };
  const file = path.join(s.dir, "chat_history.jsonl");
  if (!fs.existsSync(file)) return { ok: true, dropped: 0 };
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let lastUser = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const type = row.type || row.role;
    if (type === "user" && !row.synthetic_reason) lastUser = i;
  }
  if (lastUser < 0) return { ok: true, dropped: 0 };
  const kept = lines.slice(0, lastUser);
  while (kept.length && !String(kept[kept.length - 1] || "").trim()) kept.pop();
  fs.writeFileSync(file, kept.length ? kept.join("\n") + "\n" : "", "utf8");
  return { ok: true, dropped: lines.length - lastUser };
}

function deleteSessionDir(sessionId) {
  const s = findSession(sessionId);
  if (!s) throw new Error("会话不存在");
  // safety: only delete under sessions root
  const root = path.resolve(sessionsRoot());
  const dir = path.resolve(s.dir);
  if (!dir.startsWith(root + path.sep) && dir !== root) {
    throw new Error("拒绝删除：路径不在会话目录内");
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, id: sessionId };
}

function sessionGoalPath(sessionDir) {
  return path.join(sessionDir, "desktop-goal.json");
}

function loadSessionGoal(sessionDir) {
  if (!sessionDir) return null;
  const data = safeReadJson(sessionGoalPath(sessionDir));
  return data && typeof data === "object" ? data : null;
}

function saveSessionGoal(sessionDir, info) {
  if (!sessionDir || !info) return false;
  fs.writeFileSync(
    sessionGoalPath(sessionDir),
    JSON.stringify({
      kind: info.kind || "goal",
      label: info.label || "goal",
      paused: !!info.paused,
      savedAt: Date.now(),
    }),
    "utf8",
  );
  return true;
}

function sessionPlanPath(sessionDir) {
  return path.join(sessionDir, "desktop-plan.json");
}

function loadSessionPlan(sessionDir) {
  if (!sessionDir) return null;
  const data = safeReadJson(sessionPlanPath(sessionDir));
  if (!data || typeof data !== "object") return null;
  return data;
}

function saveSessionPlan(sessionDir, plan) {
  if (!sessionDir || !plan || typeof plan !== "object") return false;
  const raw = { ...plan };
  delete raw.sessionId;
  const out = {
    entries: raw.entries || raw.plan || raw.items || raw.steps || [],
    status: raw.status || null,
    savedAt: Date.now(),
  };
  if (!Array.isArray(out.entries) || !out.entries.length) {
    if (raw.content || raw.text) {
      out.entries = [{ content: raw.content || raw.text, status: raw.status || "pending" }];
    } else {
      return false;
    }
  }
  fs.writeFileSync(sessionPlanPath(sessionDir), JSON.stringify(out), "utf8");
  return true;
}

module.exports = {
  grokHome,
  sessionsRoot,
  listSessions,
  loadHistoryPreview,
  findSession,
  ensureSessionSummary,
  renameSession,
  deleteSessionDir,
  rewindLastUserTurn,
  extractTextContent,
  cleanUserText,
  isUserVisibleSession,
  loadSessionPlan,
  saveSessionPlan,
  loadSessionGoal,
  saveSessionGoal,
};

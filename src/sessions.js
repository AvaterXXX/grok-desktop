const fs = require("fs");
const path = require("path");
const { defaultCwd, homeDir } = require("./platform");
const { atomicWriteFileSync, atomicWriteJsonSync } = require("./file-store");

const SESSION_INDEX_TTL_MS = 1500;
let sessionIndexCache = null;
let sessionIndexPromise = null;

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

function sessionRowFromSummary(full, data) {
  if (!data?.info?.id) return null;
  const title = data.generated_title || data.session_summary || data.info.id.slice(0, 8);
  return {
    id: data.info.id,
    cwd: data.info.cwd || null,
    title: String(title).replace(/\s+/g, " ").trim(),
    summary: (data.session_summary || "").slice(0, 200),
    createdAt: data.created_at || null,
    updatedAt: data.updated_at || data.last_active_at || null,
    model: data.current_model_id || null,
    numMessages: data.num_chat_messages ?? data.num_messages ?? 0,
    dir: path.dirname(full),
    internal: !isUserVisibleSession(data),
  };
}

function cacheSessionRows(root, rows) {
  rows.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  sessionIndexCache = {
    root,
    rows,
    byId: new Map(rows.map((row) => [row.id, row])),
    at: Date.now(),
  };
  return sessionIndexCache;
}

function validSessionIndex(root) {
  return (
    sessionIndexCache &&
    sessionIndexCache.root === root &&
    Date.now() - sessionIndexCache.at < SESSION_INDEX_TTL_MS
  );
}

function invalidateSessionIndex() {
  sessionIndexCache = null;
  sessionIndexPromise = null;
}

function visibleSessionRows(rows, includeInternal) {
  return includeInternal ? rows : rows.filter((row) => !row.internal);
}

function scanSessionsSync(root) {
  if (!fs.existsSync(root)) return cacheSessionRows(root, []);
  const rows = [];
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
        if (ent.name === "session_search.sqlite" || ent.name.endsWith(".sqlite")) continue;
        stack.push(full);
        continue;
      }
      if (ent.name !== "summary.json") continue;
      const row = sessionRowFromSummary(full, safeReadJson(full));
      if (row) rows.push(row);
    }
  }
  return cacheSessionRows(root, rows);
}

async function scanSessionsAsync(root) {
  try {
    await fs.promises.access(root);
  } catch {
    return cacheSessionRows(root, []);
  }
  const rows = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const summaries = [];
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "session_search.sqlite" || ent.name.endsWith(".sqlite")) continue;
        stack.push(full);
      } else if (ent.name === "summary.json") {
        summaries.push(full);
      }
    }
    const parsed = await Promise.all(
      summaries.map(async (full) => {
        try {
          return sessionRowFromSummary(full, JSON.parse(await fs.promises.readFile(full, "utf8")));
        } catch {
          return null;
        }
      }),
    );
    rows.push(...parsed.filter(Boolean));
  }
  return cacheSessionRows(root, rows);
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
  t = t.replace(/<system[-_]reminder(?:\s[^>]*)?>[\s\S]*?<\/system[-_]reminder>/gi, "");
  t = t.replace(/<\/?[a-zA-Z_][\w:-]*(?:\s[^>]*)?>/g, " ");
  return t
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(text, max = 4000) {
  if (!text || text.length <= max) return text || "";
  return text.slice(0, max) + "\n…";
}

/** Internal sub-agent traces are not restorable as normal user sessions. */
function isUserVisibleSession(data) {
  const kind = String(data?.session_kind || "")
    .trim()
    .toLowerCase();
  return !kind.startsWith("subagent");
}

/**
 * Walk ~/.grok/sessions for summary.json files.
 * Returns newest-first list.
 */
function listSessions({ limit = 200, includeInternal = false } = {}) {
  const root = sessionsRoot();
  const index = validSessionIndex(root) ? sessionIndexCache : scanSessionsSync(root);
  return visibleSessionRows(index.rows, includeInternal).slice(0, limit).map(stripInternalFlag);
}

async function listSessionsAsync({ limit = 200, includeInternal = false } = {}) {
  const root = sessionsRoot();
  if (!validSessionIndex(root)) {
    if (!sessionIndexPromise) {
      sessionIndexPromise = scanSessionsAsync(root).finally(() => {
        sessionIndexPromise = null;
      });
    }
    await sessionIndexPromise;
  }
  return visibleSessionRows(sessionIndexCache?.rows || [], includeInternal)
    .slice(0, limit)
    .map(stripInternalFlag);
}

function stripInternalFlag(row) {
  const { internal: _internal, ...publicRow } = row;
  return publicRow;
}

function reasoningFullText(row) {
  const parts = [
    reasoningSummaryText(row),
    extractTextContent(row && row.content),
    typeof row?.text === "string" ? row.text : "",
    typeof row?.thinking === "string" ? row.thinking : "",
  ].filter(Boolean);
  let best = "";
  for (const p of parts) {
    if (p.length > best.length) best = p;
  }
  return String(best).trim();
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

function parseToolInput(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!/^[{[]/.test(text)) return value;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * Load a conversation preview: user / thought / tool / assistant.
 * Tails last ~2MB so huge sessions stay cheap. Does not replay ACP streams.
 */
function loadHistoryPreview(
  sessionDir,
  { maxMessages = 500, maxChars = 24000, maxBytes = 2 * 1024 * 1024 } = {},
) {
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
      const text = truncate(reasoningFullText(row), Math.max(maxChars, 200000));
      if (text) {
        const lastThought = messages[messages.length - 1];
        const isAdjacentThought =
          lastThought?.role === "thought" || lastThought?.kind === "thought";
        if (isAdjacentThought) {
          if (!String(lastThought.text || "").endsWith(text)) {
            lastThought.text =
              String(lastThought.text || "") +
              (lastThought.text && !String(lastThought.text).endsWith(" ") ? "\n\n" : "") +
              text;
          }
        } else {
          messages.push({ role: "thought", kind: "thought", text });
        }
      }
    } else if (type === "assistant" || type === "model") {
      const calls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
      // Persisted assistant content is the commentary that introduced the
      // calls. Keep it before the tool cards, matching the live event order.
      const text = truncate(extractTextContent(row.content).trim(), maxChars);
      if (text) messages.push({ role: "assistant", text });
      for (const c of calls) {
        if (!c) continue;
        const id = c.id || c.tool_call_id || c.toolCallId;
        const name = c.name || c.toolName || c.function?.name || "工具";
        const rawInput = c.arguments ?? c.input ?? c.function?.arguments;
        const item = {
          role: "tool",
          kind: "tool",
          toolCallId: id,
          title: name,
          kindName: name,
          status: "completed",
          rawInput: parseToolInput(rawInput),
          text: name,
        };
        messages.push(item);
        if (id) toolIndex.set(id, messages.length - 1);
      }
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
  const root = sessionsRoot();
  if (sessionIndexCache?.root === root && sessionIndexCache.byId.has(sessionId)) {
    return stripInternalFlag(sessionIndexCache.byId.get(sessionId));
  }
  // Fast path: walk only matching id folder names
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
              title: data.generated_title || data.session_summary || data.info.id.slice(0, 8),
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
  return (
    listSessions({ limit: 5000, includeInternal: true }).find((s) => s.id === sessionId) || null
  );
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
  atomicWriteJsonSync(summaryPath, data, { pretty: true });
  invalidateSessionIndex();
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
  atomicWriteJsonSync(summaryPath, data, { pretty: true });
  invalidateSessionIndex();
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
  atomicWriteFileSync(file, kept.length ? kept.join("\n") + "\n" : "", "utf8");
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
  invalidateSessionIndex();
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
  atomicWriteJsonSync(sessionGoalPath(sessionDir), {
    kind: info.kind || "goal",
    label: info.label || "goal",
    paused: !!info.paused,
    savedAt: Date.now(),
  });
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
  atomicWriteJsonSync(sessionPlanPath(sessionDir), out);
  return true;
}

function sessionUiPath(sessionDir) {
  return path.join(sessionDir, "desktop-ui.json");
}

const DESKTOP_UI_VERSION = 2;

function clipUiText(value, max = 2 * 1024 * 1024) {
  if (value == null) return "";
  return String(value).slice(0, max);
}

/** Pure, forward-compatible migration for per-session renderer recovery data. */
function migrateSessionUi(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const fromVersion = Number.isInteger(raw.version) ? raw.version : 0;
  // Never downgrade data created by a newer desktop build. Preserve unknown
  // keys while keeping the fields this renderer consumes type-safe.
  const next = { ...raw };
  if (fromVersion < 1) {
    if (next.draft == null && next.input != null) next.draft = next.input;
    if (next.lastUser == null && next.user != null) next.lastUser = next.user;
    if (next.lastThought == null && next.thought != null) next.lastThought = next.thought;
    if (next.lastAssistant == null && next.assistant != null) next.lastAssistant = next.assistant;
    if (next.stopped == null && next.cancelled != null) next.stopped = !!next.cancelled;
    delete next.input;
    delete next.user;
    delete next.thought;
    delete next.assistant;
    delete next.cancelled;
  }
  // v2 establishes bounded recovery strings and an explicit boolean stop
  // marker. Apply these invariants on every read, including malformed files
  // that already claim the current version.
  if (next.draft != null) next.draft = clipUiText(next.draft, 256 * 1024);
  if (next.lastUser != null) next.lastUser = clipUiText(next.lastUser);
  if (next.lastThought != null) next.lastThought = clipUiText(next.lastThought);
  if (next.lastAssistant != null) next.lastAssistant = clipUiText(next.lastAssistant);
  if (next.stopped != null) next.stopped = !!next.stopped;
  next.version = Math.max(fromVersion, DESKTOP_UI_VERSION);
  return next;
}

function loadSessionUi(sessionDir) {
  if (!sessionDir) return null;
  const data = safeReadJson(sessionUiPath(sessionDir));
  if (!data || typeof data !== "object") return null;
  const migrated = migrateSessionUi(data);
  if (!migrated) return null;
  if ((Number.isInteger(data.version) ? data.version : 0) < DESKTOP_UI_VERSION) {
    try {
      atomicWriteJsonSync(sessionUiPath(sessionDir), migrated);
    } catch {
      /* reading recovery state must still succeed on a read-only volume */
    }
  }
  return migrated;
}

function saveSessionUi(sessionDir, info) {
  if (!sessionDir || !info || typeof info !== "object") return false;
  const prev = loadSessionUi(sessionDir) || {};
  const next = migrateSessionUi({ ...prev, ...info, version: DESKTOP_UI_VERSION });
  next.savedAt = Date.now();
  atomicWriteJsonSync(sessionUiPath(sessionDir), next);
  return true;
}

module.exports = {
  grokHome,
  sessionsRoot,
  listSessions,
  listSessionsAsync,
  invalidateSessionIndex,
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
  loadSessionUi,
  saveSessionUi,
  migrateSessionUi,
  DESKTOP_UI_VERSION,
};

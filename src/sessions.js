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
  if (kind.startsWith("subagent")) return false;
  // 空壳会话（从未发过消息，标题退化为 01a… ID）只在刚创建的短窗口内显示，
  // 避免侧栏长期堆积打不开内容的空会话
  const msgs = Number(data?.num_chat_messages ?? data?.num_messages ?? 0) || 0;
  if (msgs <= 0) {
    const created = Date.parse(data?.created_at || "");
    if (Number.isFinite(created) && Date.now() - created > 30 * 60 * 1000) return false;
  }
  return true;
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

function acpContentText(content) {
  if (typeof content === "string") return content;
  if (!content) return "";
  if (Array.isArray(content)) return content.map(acpContentText).filter(Boolean).join("\n");
  if (typeof content !== "object") return "";
  if (typeof content.text === "string") return content.text;
  if (content.content != null) return acpContentText(content.content);
  return "";
}

function compactToolOutput(update, maxChars) {
  const content = acpContentText(update?.content);
  if (content) return truncate(content, maxChars);
  const raw = update?.rawOutput;
  if (raw == null) return "";
  if (typeof raw === "string") return truncate(raw, maxChars);
  try {
    return truncate(JSON.stringify(raw), maxChars);
  } catch {
    return truncate(String(raw), maxChars);
  }
}

function appendAdjacentText(messages, role, text, extra = {}) {
  const value = String(text || "");
  if (!value) return;
  const last = messages[messages.length - 1];
  if (last?.role === role) {
    last.text = String(last.text || "") + value;
    return;
  }
  messages.push({ role, text: value, ...extra });
}

function eventCreatedAt(packet, update) {
  const value =
    packet?.timestamp ??
    packet?.createdAt ??
    packet?.time ??
    packet?.params?.timestamp ??
    packet?.params?._meta?.timestamp ??
    update?.timestamp ??
    update?.createdAt;
  if (value == null || value === "") return null;
  const raw = typeof value === "number" && value < 1e12 ? value * 1000 : value;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readUtf8Tail(file, maxBytes) {
  if (!fs.existsSync(file)) return null;
  let fd;
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, Math.max(0, Number(maxBytes) || 0));
    if (!size) return "";
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buf, 0, size, st.size - size);
    let raw = buf.subarray(0, bytesRead).toString("utf8");
    if (size < st.size) {
      const nl = raw.indexOf("\n");
      if (nl >= 0) raw = raw.slice(nl + 1);
    }
    return raw;
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* read failure already handled above */
      }
    }
  }
}

/** Rebuild the visible timeline from the append-only ACP event log after compaction. */
function loadUpdateHistoryPreview(
  sessionDir,
  { maxMessages = 2000, maxChars = 200000, maxBytes = 32 * 1024 * 1024 } = {},
) {
  const file = path.join(sessionDir, "updates.jsonl");
  const raw = readUtf8Tail(file, maxBytes);
  if (raw == null) return [];

  const messages = [];
  const toolIndex = new Map();
  const seenEvents = new Set();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let packet;
    try {
      packet = JSON.parse(line);
    } catch {
      continue;
    }
    const update = packet?.params?.update;
    if (!update || typeof update !== "object") continue;
    const eventId = packet?.params?._meta?.eventId;
    if (eventId && seenEvents.has(eventId)) continue;
    if (eventId) seenEvents.add(eventId);
    const type = update.sessionUpdate || update.type;
    const createdAt = eventCreatedAt(packet, update);

    if (type === "user_message_chunk") {
      const text = truncate(cleanUserText(acpContentText(update.content) || update.text), maxChars);
      appendAdjacentText(messages, "user", text, createdAt ? { createdAt } : {});
    } else if (type === "agent_thought_chunk") {
      const text = truncate(acpContentText(update.content) || update.text, maxChars);
      appendAdjacentText(messages, "thought", text, {
        kind: "thought",
        ...(createdAt ? { createdAt } : {}),
      });
    } else if (type === "agent_message_chunk") {
      const text = truncate(acpContentText(update.content) || update.text, maxChars);
      appendAdjacentText(messages, "assistant", text, createdAt ? { createdAt } : {});
    } else if (type === "tool_call") {
      const id = update.toolCallId;
      const title = update.title || update.kind || "工具";
      const item = {
        role: "tool",
        kind: "tool",
        toolCallId: id,
        title,
        kindName: update.kind || title,
        status: update.status || "running",
        rawInput: update.rawInput ?? update.input ?? null,
        text: title,
        ...(createdAt ? { createdAt } : {}),
      };
      messages.push(item);
      if (id) toolIndex.set(id, messages.length - 1);
    } else if (type === "tool_call_update") {
      const id = update.toolCallId;
      let item = id && toolIndex.has(id) ? messages[toolIndex.get(id)] : null;
      if (!item) {
        const title = update.title || update.kind || "工具";
        item = {
          role: "tool",
          kind: "tool",
          toolCallId: id,
          title,
          kindName: update.kind || title,
          status: update.status || "updated",
          text: title,
          ...(createdAt ? { createdAt } : {}),
        };
        messages.push(item);
        if (id) toolIndex.set(id, messages.length - 1);
      }
      if (update.title) item.title = update.title;
      if (update.kind) item.kindName = update.kind;
      if (update.rawInput != null || update.input != null) {
        item.rawInput = update.rawInput ?? update.input;
      }
      item.status = update.status || item.status || "updated";
      const detail = compactToolOutput(update, 1200);
      if (detail) {
        item.detail = detail;
        item.rawOutput = detail;
      }
    }
  }

  if (messages.length > maxMessages) return messages.slice(-maxMessages);
  return messages;
}

function comparableMessageText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function recoveredTimelineCovers(primary, recovered) {
  const currentUsers = primary.filter((item) => item?.role === "user");
  const recoveredUsers = recovered.filter((item) => item?.role === "user");
  if (!recoveredUsers.length || recoveredUsers.length < currentUsers.length) return false;
  if (!currentUsers.length) return recovered.length > 0;
  const probe = currentUsers.slice(-Math.min(8, currentUsers.length));
  const tail = recoveredUsers.slice(-probe.length);
  return probe.every(
    (item, index) => comparableMessageText(item.text) === comparableMessageText(tail[index]?.text),
  );
}

function enrichTimelineTimestamps(primary, recovered) {
  const cursors = new Map();
  for (const item of primary) {
    if (item?.createdAt) continue;
    if (item?.role === "tool" && item.toolCallId) {
      const hit = recovered.find(
        (candidate) =>
          candidate?.role === "tool" &&
          candidate.toolCallId &&
          candidate.toolCallId === item.toolCallId &&
          candidate.createdAt,
      );
      if (hit) item.createdAt = hit.createdAt;
      continue;
    }
    const role = item?.role;
    if (!role) continue;
    const start = cursors.get(role) || 0;
    const text = comparableMessageText(item.text);
    for (let i = start; i < recovered.length; i++) {
      const candidate = recovered[i];
      if (candidate?.role !== role) continue;
      if (text && comparableMessageText(candidate.text) !== text) continue;
      if (candidate.createdAt) item.createdAt = candidate.createdAt;
      cursors.set(role, i + 1);
      break;
    }
  }
  return primary;
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
  const raw = readUtf8Tail(file, maxBytes);
  if (raw == null) {
    return loadUpdateHistoryPreview(sessionDir, {
      maxMessages,
      maxChars,
      maxBytes: Math.max(maxBytes, 32 * 1024 * 1024),
    });
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
    const createdAt = eventCreatedAt(row, row);
    if (type === "system") continue;
    if (type === "user") {
      if (row.synthetic_reason) continue;
      const text = truncate(cleanUserText(extractTextContent(row.content)), maxChars);
      if (text) messages.push({ role: "user", text, ...(createdAt ? { createdAt } : {}) });
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
          messages.push({
            role: "thought",
            kind: "thought",
            text,
            ...(createdAt ? { createdAt } : {}),
          });
        }
      }
    } else if (type === "assistant" || type === "model") {
      const calls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
      // Persisted assistant content is the commentary that introduced the
      // calls. Keep it before the tool cards, matching the live event order.
      const text = truncate(extractTextContent(row.content).trim(), maxChars);
      if (text) messages.push({ role: "assistant", text, ...(createdAt ? { createdAt } : {}) });
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
          ...(createdAt ? { createdAt } : {}),
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
          ...(createdAt ? { createdAt } : {}),
        });
      }
    }
  }

  const recovered = loadUpdateHistoryPreview(sessionDir, {
    maxMessages,
    maxChars,
    maxBytes: Math.max(maxBytes, 32 * 1024 * 1024),
  });
  if (recoveredTimelineCovers(messages, recovered)) return recovered;
  enrichTimelineTimestamps(messages, recovered);

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

function loadLatestGoalUpdate(sessionDir, maxBytes = 2 * 1024 * 1024) {
  const file = path.join(sessionDir, "updates.jsonl");
  try {
    const raw = readUtf8Tail(file, maxBytes);
    if (raw == null) return null;
    const lines = raw.split("\n");
    const { normalizeGoalState } = require("./goal-state");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (
        !lines[i].includes("goal_updated") &&
        !/goal clear|Goal cleared|No goal set/i.test(lines[i])
      ) {
        continue;
      }
      let packet;
      try {
        packet = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const update = packet?.params?.update;
      const createdAt = eventCreatedAt(packet, update);
      const savedAt = createdAt ? new Date(createdAt).getTime() : Date.now();
      const type = update?.sessionUpdate || update?.type;
      if (type === "goal_updated") {
        return normalizeGoalState({ ...update, savedAt });
      }
      const text = String(acpContentText(update?.content) || update?.text || "").trim();
      const explicitClear =
        (type === "user_message_chunk" && /^\/goal\s+clear\s*$/i.test(text)) ||
        (type === "agent_message_chunk" && /^(?:Goal cleared\.?|No goal set\b)/i.test(text));
      if (explicitClear) {
        return normalizeGoalState({
          status: "cleared",
          completed: true,
          lastEvent: "goal_cleared",
          savedAt,
        });
      }
    }
  } catch {
    return null;
  }
  return null;
}

function loadSessionGoal(sessionDir) {
  if (!sessionDir) return null;
  const data = safeReadJson(sessionGoalPath(sessionDir));
  const { isGoalRestorable, normalizeGoalState } = require("./goal-state");
  const saved = data && typeof data === "object" ? normalizeGoalState(data) : null;
  const latest = loadLatestGoalUpdate(sessionDir);
  const selected =
    !saved || (latest && Number(latest.savedAt) >= Number(saved.savedAt)) ? latest : saved;
  // Old desktop builds persisted `/goal resume` and `/goal status` as a fake
  // active goal. Discard those placeholders instead of prompting on every boot.
  if (selected && !selected.completed && !isGoalRestorable(selected)) return null;
  return selected || null;
}

function saveSessionGoal(sessionDir, info) {
  if (!sessionDir || !info) return false;
  const { normalizeGoalState } = require("./goal-state");
  const normalized = normalizeGoalState(info);
  if (!normalized) return false;
  atomicWriteJsonSync(sessionGoalPath(sessionDir), normalized);
  return true;
}

function clearSessionGoal(sessionDir, { clearPlan = true, terminalGoal = null } = {}) {
  if (!sessionDir) return false;
  const { normalizeGoalState } = require("./goal-state");
  const terminal = normalizeGoalState({
    ...(terminalGoal && typeof terminalGoal === "object" ? terminalGoal : {}),
    status: terminalGoal?.status || "cleared",
    completed: true,
    lastEvent: terminalGoal?.lastEvent || terminalGoal?.last_event || "goal_cleared",
    savedAt: Number(terminalGoal?.savedAt) || Date.now(),
  });
  atomicWriteJsonSync(sessionGoalPath(sessionDir), terminal);
  let changed = true;
  if (clearPlan) {
    try {
      fs.unlinkSync(sessionPlanPath(sessionDir));
      changed = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return changed;
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

const DESKTOP_UI_VERSION = 4;

function clipUiText(value, max = 2 * 1024 * 1024) {
  if (value == null) return "";
  return String(value).slice(0, max);
}

function normalizePendingUserMessages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item, index) => ({
      id: clipUiText(item.id || `pending-${index}`, 128),
      text: clipUiText(item.text, 40 * 1024),
      createdAt: clipUiText(item.createdAt, 64) || null,
    }))
    .filter((item) => item.text.trim())
    .slice(-6);
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
    if (next.stopped == null && next.cancelled != null) next.stopped = !!next.cancelled;
    delete next.input;
    delete next.user;
    delete next.thought;
    delete next.assistant;
    delete next.cancelled;
  }
  // v3 removes aggregate thought/assistant recovery. Those strings have no
  // event positions and could replay a whole turn above its tool cards.
  if (fromVersion < 3) {
    delete next.lastThought;
    delete next.lastAssistant;
  }
  if (fromVersion < 4 && !Array.isArray(next.pendingUserMessages) && next.lastUser) {
    next.pendingUserMessages = [
      {
        id: `legacy-${Number(next.savedAt) || Date.now()}`,
        text: next.lastUser,
        createdAt: next.lastUserAt || eventCreatedAt({ timestamp: next.savedAt }),
      },
    ];
  }
  // Keep the remaining recovery fields bounded and type-safe on every read,
  // including malformed files that already claim the current version.
  if (next.draft != null) next.draft = clipUiText(next.draft, 128 * 1024);
  if (next.lastUser != null) next.lastUser = clipUiText(next.lastUser, 64 * 1024);
  if (next.lastUserAt != null) next.lastUserAt = clipUiText(next.lastUserAt, 64);
  next.pendingUserMessages = normalizePendingUserMessages(next.pendingUserMessages);
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
  loadUpdateHistoryPreview,
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
  clearSessionGoal,
  loadSessionUi,
  saveSessionUi,
  migrateSessionUi,
  DESKTOP_UI_VERSION,
};

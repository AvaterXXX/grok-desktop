const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { defaultCwd, homeDir } = require("./platform");
const { atomicWriteFileSync, atomicWriteJsonSync } = require("./file-store");

const SESSION_INDEX_TTL_MS = 5000;
let sessionIndexCache = null;
let sessionIndexPromise = null;
/**
 * Per-directory listing, keyed by directory mtime.
 *
 * A refresh only needs to notice new / removed / changed summaries. Walking
 * every directory under the sessions root (thousands of `assets/`, `subagents/`
 * and `compaction/` folders) on each refresh was the bulk of the cost, and a
 * directory's own mtime already changes whenever an entry is added, removed or
 * renamed. So listings are reused until that mtime moves.
 */
const dirListingCache = new Map();
const DIR_LISTING_CACHE_LIMIT = 2000;
/**
 * summary.json → parsed JSON, keyed by (size, mtime).
 *
 * The *row* is rebuilt on every scan because parts of it (activity time,
 * visibility window) are time-dependent; only the expensive JSON parse is
 * reused.
 */
const summaryJsonCache = new Map();
const SUMMARY_JSON_CACHE_LIMIT = 4000;
/** Summaries live at `<root>/<group>/<id>/summary.json`; cap the walk defensively. */
const MAX_SESSION_DIR_DEPTH = 4;

function cacheMapSet(cache, key, value, limit) {
  cache.set(key, value);
  if (cache.size <= limit) return;
  // Map preserves insertion order; drop the oldest quarter in one pass instead
  // of re-sorting a large cache on every insert.
  const drop = Math.ceil(limit / 4);
  let removed = 0;
  for (const oldest of cache.keys()) {
    cache.delete(oldest);
    if (++removed >= drop) break;
  }
}

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

/** Events that mean the conversation itself changed. session/load bookkeeping is absent. */
const CONVERSATION_UPDATE_KINDS = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "goal_updated",
  "turn_completed",
  "subagent_spawned",
  "subagent_finished",
]);

function activityIsoFromUpdateLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  let packet;
  try {
    packet = JSON.parse(text);
  } catch {
    return null;
  }
  const update = packet?.params?.update;
  const kind = String(update?.sessionUpdate || update?.type || "");
  if (!CONVERSATION_UPDATE_KINDS.has(kind)) return null;
  return eventCreatedAt(packet, update);
}

/** Timestamp from the head of a line too large to parse as one JSON value. */
function activityIsoFromLineHead(text) {
  const head = String(text || "").split("\n", 1)[0];
  const parsed = activityIsoFromUpdateLine(head);
  if (parsed) return parsed;
  const kind = head.match(/"sessionUpdate"\s*:\s*"([^"]+)"/);
  if (!kind || !CONVERSATION_UPDATE_KINDS.has(kind[1])) return null;
  const ts = head.match(/"timestamp"\s*:\s*(\d+(?:\.\d+)?)/);
  if (!ts) return null;
  return eventCreatedAt({ timestamp: Number(ts[1]) }, null);
}

function readUpdateLineHead(fd, endExclusive) {
  let pos = endExclusive;
  const window = 64 * 1024;
  for (let guard = 0; pos > 0 && guard < 64; guard += 1) {
    const start = Math.max(0, pos - window);
    const len = pos - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let nl = -1;
    for (let i = len - 1; i >= 0; i -= 1) {
      if (buf[i] !== 0x0a) continue;
      if (pos === endExclusive && i === len - 1) continue;
      nl = i;
      break;
    }
    if (nl >= 0 || start === 0) {
      const lineStart = nl >= 0 ? start + nl + 1 : 0;
      const headLen = Math.min(8192, Math.max(0, endExclusive - lineStart));
      const head = Buffer.alloc(headLen);
      const n = fs.readSync(fd, head, 0, headLen, lineStart);
      return {
        lineStart,
        iso: activityIsoFromLineHead(head.subarray(0, n).toString("utf8")),
      };
    }
    pos = start;
  }
  return { lineStart: 0, iso: null };
}

const conversationActivityCache = new Map();

/**
 * Last time the conversation changed.
 * summary updated_at / last_active_at also move when the CLI loads a session
 * and appends bookkeeping, so they are not the sidebar clock.
 */
function conversationActivityAt(sessionDir) {
  if (!sessionDir) return null;
  const file = path.join(sessionDir, "updates.jsonl");
  let fd;
  try {
    const st = fs.statSync(file);
    const cached = conversationActivityCache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.iso;
    const store = (iso) => {
      conversationActivityCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, iso });
      return iso;
    };
    if (!st.size) return store(null);
    fd = fs.openSync(file, "r");
    const chunkSize = 64 * 1024;
    const maxScan = 1024 * 1024;
    let end = st.size;
    let scanned = 0;
    while (end > 0 && scanned <= maxScan) {
      const start = Math.max(0, end - chunkSize);
      const buf = Buffer.alloc(end - start);
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      if (!n) return null;
      scanned += n;
      const partial = start > 0;
      const newline = partial ? buf.subarray(0, n).indexOf(0x0a) : -1;
      if (partial && newline < 0) {
        const found = readUpdateLineHead(fd, end);
        if (found.iso) return store(found.iso);
        if (found.lineStart <= 0) return store(null);
        end = found.lineStart;
        continue;
      }
      const body = partial && newline >= 0 ? buf.subarray(newline + 1, n) : buf.subarray(0, n);
      const lines = body.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const iso = activityIsoFromUpdateLine(lines[i]);
        if (iso) return store(iso);
      }
      if (start === 0) return store(null);
      end = newline >= 0 ? start + newline : start;
    }
    return store(null);
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the caller already has a null activity time */
      }
    }
  }
}

function sessionRowFromSummary(full, data) {
  if (!data?.info?.id) return null;
  const title = data.generated_title || data.session_summary || data.info.id.slice(0, 8);
  const dir = path.dirname(full);
  return {
    id: data.info.id,
    cwd: data.info.cwd || null,
    title: String(title).replace(/\s+/g, " ").trim(),
    summary: (data.session_summary || "").slice(0, 200),
    createdAt: data.created_at || null,
    updatedAt: conversationActivityAt(dir) || data.created_at || null,
    model: data.current_model_id || null,
    effort: data.reasoning_effort || null,
    numMessages: data.num_chat_messages ?? data.num_messages ?? 0,
    dir,
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
  dirListingCache.clear();
  summaryJsonCache.clear();
}

function visibleSessionRows(rows, includeInternal) {
  return includeInternal ? rows : rows.filter((row) => !row.internal);
}

/**
 * Directory entries for `dir`, reusing the previous listing while the
 * directory itself has not changed. Returns `null` on a cache miss.
 */
function cachedDirEntries(dir, stat) {
  const cached = dirListingCache.get(dir);
  if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) return null;
  return cached.entries;
}

function storeDirEntries(dir, stat, entries) {
  cacheMapSet(
    dirListingCache,
    dir,
    { mtimeMs: stat.mtimeMs, size: stat.size, entries },
    DIR_LISTING_CACHE_LIMIT,
  );
  return entries;
}

/** Parse a summary.json, reusing the parse while the file signature is stable. */
function readSummaryJson(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = summaryJsonCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.data;
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    data = null;
  }
  cacheMapSet(
    summaryJsonCache,
    file,
    { mtimeMs: st.mtimeMs, size: st.size, data },
    SUMMARY_JSON_CACHE_LIMIT,
  );
  return data;
}

/**
 * Descend from `dir` into the child directories that can still hold sessions.
 * Session directories themselves are never descended into: their `assets/`,
 * `subagents/` and `compaction/` trees are the bulk of the filesystem but never
 * contain a summary.json.
 */
function childSessionDirs(dir, entries, depth) {
  if (depth >= MAX_SESSION_DIR_DEPTH) return [];
  const out = [];
  for (const entry of entries) {
    if (!entry.dir) continue;
    if (entry.name === "session_search.sqlite" || entry.name.endsWith(".sqlite")) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

function toDirEntries(listed) {
  return listed.map((entry) => ({ name: entry.name, dir: entry.isDirectory() }));
}

function collectSessionRowsSync(root) {
  const rows = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    let entries = cachedDirEntries(dir, stat);
    if (!entries) {
      try {
        entries = storeDirEntries(dir, stat, toDirEntries(fs.readdirSync(dir, { withFileTypes: true })));
      } catch {
        continue;
      }
    }
    const summary = entries.find((entry) => entry.name === "summary.json" && !entry.dir);
    if (summary) {
      const full = path.join(dir, summary.name);
      const row = sessionRowFromSummary(full, readSummaryJson(full));
      if (row) rows.push(row);
      continue;
    }
    for (const child of childSessionDirs(dir, entries, depth)) stack.push({ dir: child, depth: depth + 1 });
  }
  return rows;
}

/** Same traversal as the sync variant, yielding to the event loop per level. */
async function collectSessionRowsAsync(root) {
  const rows = [];
  let level = [{ dir: root, depth: 0 }];
  while (level.length) {
    const next = [];
    for (const { dir, depth } of level) {
      let stat;
      try {
        stat = await fs.promises.stat(dir);
      } catch {
        continue;
      }
      let entries = cachedDirEntries(dir, stat);
      if (!entries) {
        try {
          entries = storeDirEntries(
            dir,
            stat,
            toDirEntries(await fs.promises.readdir(dir, { withFileTypes: true })),
          );
        } catch {
          continue;
        }
      }
      const summary = entries.find((entry) => entry.name === "summary.json" && !entry.dir);
      if (summary) {
        const full = path.join(dir, summary.name);
        const row = sessionRowFromSummary(full, readSummaryJson(full));
        if (row) rows.push(row);
        continue;
      }
      for (const child of childSessionDirs(dir, entries, depth)) {
        next.push({ dir: child, depth: depth + 1 });
      }
    }
    level = next;
    // Sessions can nest several levels deep; let IPC and streaming run between
    // levels instead of holding the event loop for the whole walk.
    if (level.length) await new Promise((resolve) => setImmediate(resolve));
  }
  return rows;
}

function scanSessionsSync(root) {
  if (!fs.existsSync(root)) return cacheSessionRows(root, []);
  return cacheSessionRows(root, collectSessionRowsSync(root));
}

async function scanSessionsAsync(root) {
  try {
    await fs.promises.access(root);
  } catch {
    return cacheSessionRows(root, []);
  }
  return cacheSessionRows(root, await collectSessionRowsAsync(root));
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

/**
 * Append-only JSONL timeline cursor.
 *
 * A session log is only appended to while a turn runs (and rewritten wholesale
 * on rewind). Re-parsing the whole file on every open meant a 72 MB
 * updates.jsonl cost ~500 ms of main-process time per open, freezing every
 * other IPC. The cursor remembers how many bytes it already consumed, so an
 * unchanged file costs nothing and an appended file parses only the new tail.
 */
const TIMELINE_CACHE_LIMIT = 24;
const TIMELINE_READ_CHUNK = 4 * 1024 * 1024;
const timelineCache = new Map();

function timelineKey(file, maxChars) {
  return `${file}\0${maxChars}`;
}

function createTimelineState(file, maxChars) {
  return {
    file,
    maxChars,
    offset: 0,
    size: -1,
    mtimeMs: -1,
    carry: "",
    /** Hash of the bytes already consumed; proves the file was only appended to. */
    prefix: "",
    messages: [],
    toolIndex: new Map(),
    seenEvents: new Set(),
  };
}

function resetTimelineState(state) {
  state.offset = 0;
  state.carry = "";
  state.prefix = "";
  state.messages = [];
  state.toolIndex = new Map();
  state.seenEvents = new Set();
}

/**
 * Copy a cached row before handing it out: callers annotate history rows
 * (`fileChange`, timestamps) and must never mutate the cached timeline.
 */
function copyTimelineRow(row) {
  return row && typeof row === "object" ? { ...row } : row;
}

const TIMELINE_PREFIX_WINDOW = 32 * 1024;

/**
 * Fingerprint the first and last window of the bytes already parsed.
 *
 * A log that is only appended to keeps those bytes intact, so the cursor can
 * parse just the new tail. A log that was rewritten in place (rewind, rewrite,
 * compaction) changes them, and the timeline has to be rebuilt — comparing sizes
 * alone is not enough, because a rewrite can easily produce a longer file.
 */
function timelinePrefixHash(file, offset) {
  if (!offset) return "";
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const hash = crypto.createHash("sha1");
    const head = Buffer.alloc(Math.min(TIMELINE_PREFIX_WINDOW, offset));
    const headRead = fs.readSync(fd, head, 0, head.length, 0);
    hash.update(head.subarray(0, headRead));
    const tailLen = Math.min(TIMELINE_PREFIX_WINDOW, offset);
    const tail = Buffer.alloc(tailLen);
    const tailRead = fs.readSync(fd, tail, 0, tailLen, offset - tailLen);
    hash.update(tail.subarray(0, tailRead));
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the fingerprint read already failed or completed */
      }
    }
  }
}

/** How much of the file still has to be read, or `null` when nothing changed. */
function timelineReadPlan(state, stat, file) {
  if (state.size < 0) return { reset: false, from: 0 };
  if (stat.size === state.size && stat.mtimeMs === state.mtimeMs) return null;
  if (stat.size < state.offset) return { reset: true, from: 0 };
  // The file changed: reuse the parsed prefix only when its bytes are intact.
  const prefix = timelinePrefixHash(file, state.offset);
  if (!prefix || prefix !== state.prefix) return { reset: true, from: 0 };
  return { reset: false, from: state.offset };
}

/** Split a read chunk into complete lines, keeping the trailing partial line. */
function consumeTimelineText(state, text, handleRow) {
  if (!text) return;
  const chunk = state.carry ? state.carry + text : text;
  const lines = chunk.split("\n");
  state.carry = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    handleRow(state, row);
  }
}

/**
 * Parse the trailing line that has no newline yet.
 *
 * A log written as `row1\nrow2` (no trailing newline for the newest row) would
 * otherwise leave the newest row stuck in the carry buffer until the next
 * append — the last message of a session would never appear. A *partial* line
 * (the CLI is mid-write) simply fails to parse and stays buffered.
 */
function flushTimelineCarry(state, handleRow) {
  if (!state.carry) return;
  let row;
  try {
    row = JSON.parse(state.carry);
  } catch {
    return;
  }
  state.carry = "";
  handleRow(state, row);
}

function commitTimelineState(key, state, stat) {
  state.size = stat.size;
  state.mtimeMs = stat.mtimeMs;
  const prefix = timelinePrefixHash(state.file, state.offset);
  state.prefix = prefix || "";
  cacheMapSet(timelineCache, key, state, TIMELINE_CACHE_LIMIT);
}

function loadTimelineSync(file, maxChars, handleRow) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const key = timelineKey(file, maxChars);
  const state = timelineCache.get(key) || createTimelineState(file, maxChars);
  const plan = timelineReadPlan(state, stat, file);
  if (!plan) return state;
  if (plan.reset) resetTimelineState(state);
  const length = stat.size - plan.from;
  if (length > 0) {
    let fd;
    try {
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(length);
      const read = fs.readSync(fd, buf, 0, length, plan.from);
      state.offset = plan.from + read;
      consumeTimelineText(state, buf.subarray(0, read).toString("utf8"), handleRow);
    } finally {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* the read above already failed or completed */
        }
      }
    }
  }
  commitTimelineState(key, state, stat);
  flushTimelineCarry(state, handleRow);
  return state;
}

async function loadTimelineAsync(file, maxChars, handleRow) {
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return null;
  }
  const key = timelineKey(file, maxChars);
  const state = timelineCache.get(key) || createTimelineState(file, maxChars);
  const plan = timelineReadPlan(state, stat, file);
  if (!plan) {
    // Nothing new on disk: the buffered tail was already flushed on the pass
    // that read it, so the cached timeline is complete.
    return state;
  }
  if (plan.reset) resetTimelineState(state);
  let position = plan.from;
  if (stat.size > position) {
    const handle = await fs.promises.open(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(TIMELINE_READ_CHUNK, stat.size - position));
      while (position < stat.size) {
        const want = Math.min(buf.length, stat.size - position);
        const { bytesRead } = await handle.read(buf, 0, want, position);
        if (!bytesRead) break;
        position += bytesRead;
        state.offset = position;
        consumeTimelineText(state, buf.subarray(0, bytesRead).toString("utf8"), handleRow);
        // A cold parse of a very large log must not monopolize the loop; let
        // pending IPC (keystrokes, status polls) run between chunks.
        if (position < stat.size) await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      await handle.close();
    }
  }
  commitTimelineState(key, state, stat);
  flushTimelineCarry(state, handleRow);
  return state;
}

function applyUpdateRow(state, packet) {
  const update = packet?.params?.update;
  if (!update || typeof update !== "object") return;
  const messages = state.messages;
  const eventId = packet?.params?._meta?.eventId;
  if (eventId) {
    if (state.seenEvents.has(eventId)) return;
    state.seenEvents.add(eventId);
  }
  const type = update.sessionUpdate || update.type;
  const createdAt = eventCreatedAt(packet, update);
  const maxChars = state.maxChars;

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
    messages.push({
      role: "tool",
      kind: "tool",
      toolCallId: id,
      title,
      kindName: update.kind || title,
      status: update.status || "running",
      rawInput: update.rawInput ?? update.input ?? null,
      content: update.content,
      text: title,
      ...(createdAt ? { createdAt } : {}),
    });
    if (id) state.toolIndex.set(id, messages.length - 1);
  } else if (type === "tool_call_update") {
    const id = update.toolCallId;
    let item = id ? messages[state.toolIndex.get(id)] : null;
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
      if (id) state.toolIndex.set(id, messages.length - 1);
    } else if (update.title) {
      item.title = update.title;
    }
    if (update.kind) item.kindName = update.kind;
    if (update.content) item.content = update.content;
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

function applyChatRow(state, row) {
  const messages = state.messages;
  const type = row.type || row.role;
  const createdAt = eventCreatedAt(row, row);
  const maxChars = state.maxChars;
  if (type === "system") return;
  if (type === "user") {
    if (row.synthetic_reason) return;
    const text = truncate(cleanUserText(extractTextContent(row.content)), maxChars);
    if (text) messages.push({ role: "user", text, ...(createdAt ? { createdAt } : {}) });
    return;
  }
  if (type === "reasoning" || type === "thought") {
    const text = truncate(reasoningFullText(row), Math.max(maxChars, 200000));
    if (!text) return;
    const lastThought = messages[messages.length - 1];
    if (lastThought?.role === "thought" || lastThought?.kind === "thought") {
      if (!String(lastThought.text || "").endsWith(text)) {
        lastThought.text =
          String(lastThought.text || "") +
          (lastThought.text && !String(lastThought.text).endsWith(" ") ? "\n\n" : "") +
          text;
      }
      return;
    }
    messages.push({
      role: "thought",
      kind: "thought",
      text,
      ...(createdAt ? { createdAt } : {}),
    });
    return;
  }
  if (type === "assistant" || type === "model") {
    const calls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    // Persisted assistant content is the commentary that introduced the calls.
    // Keep it before the tool cards, matching the live event order.
    const text = truncate(extractTextContent(row.content).trim(), maxChars);
    if (text) messages.push({ role: "assistant", text, ...(createdAt ? { createdAt } : {}) });
    for (const c of calls) {
      if (!c) continue;
      const id = c.id || c.tool_call_id || c.toolCallId;
      const name = c.name || c.toolName || c.function?.name || "工具";
      const rawInput = c.arguments ?? c.input ?? c.function?.arguments;
      messages.push({
        role: "tool",
        kind: "tool",
        toolCallId: id,
        title: name,
        kindName: name,
        status: "completed",
        rawInput: parseToolInput(rawInput),
        text: name,
        ...(createdAt ? { createdAt } : {}),
      });
      if (id) state.toolIndex.set(id, messages.length - 1);
    }
    return;
  }
  if (type === "tool_result" || type === "tool") {
    const id = row.tool_call_id || row.toolCallId;
    const detail = truncate(
      typeof row.content === "string" ? row.content : extractTextContent(row.content),
      1200,
    );
    if (id && state.toolIndex.has(id)) {
      const item = messages[state.toolIndex.get(id)];
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

/** Rebuild the visible timeline from the append-only ACP event log after compaction. */
function loadUpdateHistoryPreview(sessionDir, { maxChars = 200000 } = {}) {
  const file = path.join(sessionDir, "updates.jsonl");
  const state = loadTimelineSync(file, maxChars, applyUpdateRow);
  return state ? state.messages.map(copyTimelineRow) : [];
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
 * Load a conversation: user / thought / tool / assistant.
 * Does not replay ACP streams.
 *
 * Both files are consumed through the append-only cursor, so re-opening a
 * session whose logs have not changed is free and a growing log only parses its
 * new bytes.
 */
function mergeHistoryTimelines(dir, maxChars, primary, recovered) {
  const primaryRows = primary ? primary.messages.map(copyTimelineRow) : [];
  const recoveredRows = recovered ? recovered.messages.map(copyTimelineRow) : [];
  if (!primary || !primary.size) return recoveredRows;
  if (recoveredTimelineCovers(primaryRows, recoveredRows)) return recoveredRows;
  enrichTimelineTimestamps(primaryRows, recoveredRows);
  return primaryRows;
}

function loadHistoryPreviewSync(sessionDir, { maxChars = 24000 } = {}) {
  if (!sessionDir) return [];
  const primary = loadTimelineSync(
    path.join(sessionDir, "chat_history.jsonl"),
    maxChars,
    applyChatRow,
  );
  // withMax: the recovered timeline is only needed to cover compaction or to
  // fill missing timestamps; same budget as before.
  const recovered = loadTimelineSync(
    path.join(sessionDir, "updates.jsonl"),
    Math.max(maxChars, 200000),
    applyUpdateRow,
  );
  return mergeHistoryTimelines(sessionDir, maxChars, primary, recovered);
}

async function loadHistoryPreviewAsync(sessionDir, { maxChars = 24000 } = {}) {
  if (!sessionDir) return [];
  const primary = await loadTimelineAsync(
    path.join(sessionDir, "chat_history.jsonl"),
    maxChars,
    applyChatRow,
  );
  const recovered = await loadTimelineAsync(
    path.join(sessionDir, "updates.jsonl"),
    Math.max(maxChars, 200000),
    applyUpdateRow,
  );
  return mergeHistoryTimelines(sessionDir, maxChars, primary, recovered);
}

function loadHistoryPreview(sessionDir, opts = {}) {
  return loadHistoryPreviewSync(sessionDir, opts);
}

function findSession(sessionId) {
  if (!sessionId) return null;
  const root = sessionsRoot();
  if (sessionIndexCache?.root === root && sessionIndexCache.byId.has(sessionId)) {
    return stripInternalFlag(sessionIndexCache.byId.get(sessionId));
  }
  if (!fs.existsSync(root)) return null;
  // Sessions are `<root>/<group>/<id>/summary.json`. Read the directories the
  // index already discovered for this id instead of walking the whole tree
  // again — the old fallback re-scanned every directory (including each
  // session's assets/subagents) and then re-listed the index on top of it.
  const summary = path.join(root, sessionId, "summary.json");
  if (fs.existsSync(summary)) {
    const row = sessionRowFromSummary(summary, safeReadJson(summary));
    if (row) return stripInternalFlag(row);
  }
  let groups;
  try {
    groups = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const dir = path.join(root, group.name, sessionId);
    const file = path.join(dir, "summary.json");
    if (!fs.existsSync(file)) continue;
    const row = sessionRowFromSummary(file, safeReadJson(file));
    if (row) return stripInternalFlag(row);
  }
  return null;
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
    effort: data.reasoning_effort || null,
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
  data.generated_title = t;
  data.session_summary = t;
  atomicWriteJsonSync(summaryPath, data, { pretty: true });
  invalidateSessionIndex();
  return { ...s, title: t, summary: t };
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
  loadHistoryPreviewSync,
  loadHistoryPreviewAsync,
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

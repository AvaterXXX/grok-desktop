const fs = require("fs");
const path = require("path");
const { listSessionsAsync, extractTextContent, cleanUserText } = require("./sessions");

const SEARCH_READ_BYTES = 1.5 * 1024 * 1024;
const SEARCH_CACHE_TTL_MS = 10_000;
const SEARCH_CONCURRENCY = 8;
const resultCache = new Map();

async function readTailUtf8(file, maxBytes = SEARCH_READ_BYTES) {
  const st = await fs.promises.stat(file);
  if (st.size <= maxBytes) return fs.promises.readFile(file, "utf8");
  const handle = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    await handle.read(buf, 0, maxBytes, st.size - maxBytes);
    let raw = buf.toString("utf8");
    const nl = raw.indexOf("\n");
    if (nl >= 0) raw = raw.slice(nl + 1);
    return raw;
  } finally {
    await handle.close();
  }
}

function searchOneSession(s, raw, rawQ, q) {
  let bestSnippet = "";
  let matchCount = 0;
  let matchRole = null;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const type = row.type || row.role;
    if (type === "system" || type === "tool" || type === "tool_result") continue;
    let text = extractTextContent(row.content);
    if (type === "user") text = cleanUserText(text);
    if (!text) continue;
    const low = text.toLowerCase();
    if (!low.includes(q)) continue;
    matchCount++;
    if (!bestSnippet) {
      const idx = low.indexOf(q);
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + q.length + 80);
      bestSnippet =
        (start > 0 ? "…" : "") +
        text.slice(start, end).replace(/\s+/g, " ") +
        (end < text.length ? "…" : "");
      matchRole = type === "user" ? "user" : "assistant";
    }
  }
  const titleHit = (s.title || "").toLowerCase().includes(q);
  if (matchCount === 0 && !titleHit) return null;
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    updatedAt: s.updatedAt,
    matchCount: matchCount + (titleHit ? 1 : 0),
    snippet: bestSnippet || s.summary || s.title,
    query: rawQ,
    matchRole,
    titleOnly: matchCount === 0 && titleHit,
  };
}

/**
 * Full-text search across session chat_history.jsonl files.
 * Returns hits with snippet + matched query for UI highlight.
 */
async function searchSessions(query, { limit = 40 } = {}) {
  const rawQ = String(query || "").trim();
  const q = rawQ.toLowerCase();
  if (!q) return [];
  const cacheKey = `${limit}\0${q}`;
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
    return cached.rows.map((row) => ({ ...row }));
  }
  const sessions = await listSessionsAsync({ limit: 300 });
  const hits = [];
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(SEARCH_CONCURRENCY, sessions.length) },
    async () => {
      while (cursor < sessions.length) {
        const s = sessions[cursor++];
        const file = path.join(s.dir, "chat_history.jsonl");
        try {
          const hit = searchOneSession(s, await readTailUtf8(file), rawQ, q);
          if (hit) hits.push(hit);
        } catch {
          /* missing or concurrently updated session */
        }
      }
    },
  );
  await Promise.all(workers);

  hits.sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
  const rows = hits.slice(0, limit);
  resultCache.set(cacheKey, { at: Date.now(), rows });
  if (resultCache.size > 40) {
    const oldest = [...resultCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldest) resultCache.delete(oldest);
  }
  return rows.map((row) => ({ ...row }));
}

module.exports = { searchSessions };

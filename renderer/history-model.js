(function initHistoryModel(global) {
  function alignHistoryBoundary(list, start, page) {
    const floor = Math.max(0, Math.min(Number(start) || 0, list.length));
    const lookback = Math.min(Math.max(0, Number(page) || 0), 12);
    const min = Math.max(0, floor - lookback);
    for (let i = floor; i >= min; i--) {
      const row = list[i];
      if (row?.role === "user" || row?.role === "thought" || row?.kind === "thought") return i;
    }
    return floor;
  }

  function tailHistoryFrom(list, page = 40) {
    const n = Array.isArray(list) ? list.length : 0;
    if (n <= page) return 0;
    const floor = Math.max(0, n - page);
    // Keep the latest user question attached to its answer. A reply full of
    // tool/thought rows used to push the question past the scan window, so the
    // thread opened on a wall of steps with no visible question. Truly giant
    // turns still page normally so startup remains bounded.
    const maxTurnRows = Math.max(page * 3, 240);
    for (let index = n - 1; index >= Math.max(0, n - maxTurnRows); index--) {
      if (list[index]?.role === "user") return index;
    }
    return alignHistoryBoundary(list, floor, page);
  }

  function previousHistoryFrom(list, current, page = 40) {
    const rows = Array.isArray(list) ? list : [];
    const from = Math.max(0, Math.min(Number(current) || 0, rows.length));
    if (!from) return 0;
    return alignHistoryBoundary(rows, Math.max(0, from - page), page);
  }

  function parseSessionTs(value) {
    if (value == null || value === "") return NaN;
    if (typeof value === "number" && Number.isFinite(value))
      return value < 1e12 ? value * 1000 : value;
    const normalized = String(value).replace(/(\.\d{3})\d+/, "$1");
    const timestamp = Date.parse(normalized);
    return Number.isFinite(timestamp) ? timestamp : NaN;
  }

  function comparableUserText(value) {
    return String(value || "")
      .replace(/^\s*\/(?:goal|plan)\b\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function clipRecoveryText(value, max) {
    if (value == null) return "";
    return String(value).slice(0, max);
  }

  /** Keep session recovery patches comfortably below the 512 KiB IPC guard. */
  function sanitizeSessionUiPatch(patchInput) {
    const patch = patchInput && typeof patchInput === "object" ? patchInput : {};
    const safe = {};
    let remaining = 220 * 1024;
    if (Object.hasOwn(patch, "lastUserAt")) {
      safe.lastUserAt = clipRecoveryText(patch.lastUserAt, 64) || null;
    }
    if (Object.hasOwn(patch, "stopped")) safe.stopped = !!patch.stopped;
    if (Object.hasOwn(patch, "pendingUserMessages")) {
      let pendingRemaining = Math.min(128 * 1024, remaining);
      const pending = [];
      const rows = Array.isArray(patch.pendingUserMessages)
        ? patch.pendingUserMessages.slice(-6)
        : [];
      for (let index = rows.length - 1; index >= 0 && pendingRemaining > 0; index--) {
        const item = rows[index];
        if (!item || typeof item !== "object") continue;
        const text = clipRecoveryText(item.text, Math.min(32 * 1024, pendingRemaining));
        if (!text.trim()) continue;
        pendingRemaining -= text.length;
        remaining -= text.length;
        pending.unshift({
          id: clipRecoveryText(item.id || `pending-${index}`, 128),
          text,
          createdAt: clipRecoveryText(item.createdAt, 64) || null,
        });
      }
      safe.pendingUserMessages = pending;
    }
    if (Object.hasOwn(patch, "lastUser")) {
      safe.lastUser = clipRecoveryText(patch.lastUser, Math.min(64 * 1024, remaining));
      remaining -= safe.lastUser.length;
    }
    if (Object.hasOwn(patch, "draft")) {
      safe.draft = clipRecoveryText(patch.draft, Math.min(128 * 1024, remaining));
    }
    return safe;
  }

  /**
   * Merge renderer-side user-message recovery into an existing ACP timeline.
   * Existing rows keep their source order; an unmatched recovery row is placed
   * immediately before the first later timestamp instead of being appended.
   */
  function mergeRecoveredUserMessages(listInput, pendingInput) {
    const messages = Array.isArray(listInput) ? listInput.slice() : [];
    const pending = (Array.isArray(pendingInput) ? pendingInput : [])
      .filter((item) => item && String(item.text || "").trim())
      .slice()
      .sort((left, right) => {
        const a = parseSessionTs(left.createdAt);
        const b = parseSessionTs(right.createdAt);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
        return a - b;
      });
    const unresolved = [];
    const matched = new Set();

    for (const item of pending) {
      const text = String(item.text || "").trim();
      const comparable = comparableUserText(text);
      let found = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      const pendingAt = parseSessionTs(item.createdAt);

      for (let index = 0; index < messages.length; index++) {
        const row = messages[index];
        if (matched.has(row) || row?.role !== "user") continue;
        if (comparableUserText(row.text) !== comparable) continue;
        const rowAt = parseSessionTs(row.createdAt || row.timestamp);
        const distance =
          Number.isFinite(pendingAt) && Number.isFinite(rowAt)
            ? Math.abs(rowAt - pendingAt)
            : found < 0
              ? 0
              : Number.POSITIVE_INFINITY;
        if (distance < bestDistance) {
          found = index;
          bestDistance = distance;
        }
      }

      if (found >= 0) {
        matched.add(messages[found]);
        continue;
      }

      const recovered = {
        role: "user",
        text,
        createdAt: item.createdAt || null,
        pending: true,
      };
      let insertAt = messages.length;
      if (Number.isFinite(pendingAt)) {
        const later = messages.findIndex((row) => {
          const rowAt = parseSessionTs(row?.createdAt || row?.timestamp);
          return Number.isFinite(rowAt) && rowAt > pendingAt;
        });
        if (later >= 0) insertAt = later;
      }
      messages.splice(insertAt, 0, recovered);
      matched.add(recovered);
      unresolved.push(item);
    }

    return { messages, unresolved };
  }

  function mapAssetsToMessageIndex(listInput, imagesInput, sessionMeta, now = Date.now()) {
    const list = Array.isArray(listInput) ? listInput : [];
    const images = Array.isArray(imagesInput) ? imagesInput : [];
    const count = Math.max(1, list.length);
    let start = parseSessionTs(sessionMeta?.createdAt);
    let end = parseSessionTs(sessionMeta?.updatedAt);
    if (!Number.isFinite(start) && images[0]?.mtimeMs) start = images[0].mtimeMs;
    if (!Number.isFinite(end) && images[images.length - 1]?.mtimeMs)
      end = images[images.length - 1].mtimeMs;
    if (!Number.isFinite(start)) start = now - 3_600_000;
    if (!Number.isFinite(end) || end <= start) end = start + 3_600_000;
    const span = Math.max(1, end - start);
    const byIndex = new Map();

    for (const asset of images) {
      let index = -1;
      const name = asset?.name || "";
      const stem = name.replace(/\.\w+$/, "");
      if (name) {
        for (let i = 0; i < list.length; i++) {
          const text = list[i]?.text || "";
          if (text.includes(name) || (stem && text.includes(stem))) {
            index = i;
            break;
          }
        }
      }
      if (index < 0) {
        const mtime = Number(asset?.mtimeMs) || start;
        const fraction = Math.min(1, Math.max(0, (mtime - start) / span));
        index = Math.min(count - 1, Math.max(0, Math.floor(fraction * count)));
      }
      if (list[index]?.role !== "user") {
        let pinned = -1;
        for (let i = index; i >= 0; i--) {
          if (list[i]?.role === "user") {
            pinned = i;
            break;
          }
        }
        if (pinned < 0) {
          for (let i = index + 1; i < list.length; i++) {
            if (list[i]?.role === "user") {
              pinned = i;
              break;
            }
          }
        }
        if (pinned >= 0) index = pinned;
      }
      if (list[index]?.role !== "user") continue;
      if (!byIndex.has(index)) byIndex.set(index, []);
      byIndex.get(index).push(asset);
    }
    return byIndex;
  }

  global.GrokHistoryModel = {
    mapAssetsToMessageIndex,
    mergeRecoveredUserMessages,
    parseSessionTs,
    previousHistoryFrom,
    sanitizeSessionUiPatch,
    tailHistoryFrom,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

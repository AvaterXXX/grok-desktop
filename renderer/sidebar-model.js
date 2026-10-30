(function initSidebarModel(global) {
  function sortBySavedOrder(items, order, keyFn) {
    const index = new Map((order || []).map((key, position) => [String(key), position]));
    // Keys missing from the saved order (fresh sessions, never dragged) sort
    // ahead of saved ones and keep their input order, so new conversations
    // float to the top instead of sinking below the frozen drag order.
    return [...(items || [])].sort((left, right) => {
      const leftKey = String(keyFn(left));
      const rightKey = String(keyFn(right));
      const leftIndex = index.has(leftKey) ? index.get(leftKey) : -1;
      const rightIndex = index.has(rightKey) ? index.get(rightKey) : -1;
      return leftIndex - rightIndex;
    });
  }

  function promoteSidebarKey(order, key) {
    const id = String(key || "");
    const rest = [];
    const seen = new Set();
    for (const item of order || []) {
      const text = String(item || "");
      if (!text || text === id || seen.has(text)) continue;
      seen.add(text);
      rest.push(text);
    }
    return id ? [id, ...rest] : rest;
  }

  // Keep the active chat first inside its project. Unsaved siblings sort ahead
  // of any saved id, so they have to be written into the order behind it.
  function promoteSessionOrder(order, sessionId, siblingIds) {
    const id = String(sessionId || "");
    const saved = [];
    const seen = new Set();
    if (id) seen.add(id);
    for (const item of order || []) {
      const text = String(item || "");
      if (!text || seen.has(text)) continue;
      seen.add(text);
      saved.push(text);
    }
    const pinnedSiblings = [];
    for (const item of siblingIds || []) {
      const text = String(item || "");
      if (!text || seen.has(text)) continue;
      seen.add(text);
      pinnedSiblings.push(text);
    }
    return id ? [id, ...pinnedSiblings, ...saved] : [...pinnedSiblings, ...saved];
  }

  function moveKey(order, id, beforeId, placeAfter = false) {
    const next = (order || []).filter((key) => key !== id);
    const withTarget =
      next.includes(beforeId) || !beforeId
        ? next
        : [...next, beforeId].filter((key, index, all) => all.indexOf(key) === index);
    const result = withTarget.filter((key) => key !== id);
    if (!beforeId) return [...result, id];
    let index = result.indexOf(beforeId);
    if (index < 0) return [...result, id];
    if (placeAfter) index += 1;
    result.splice(index, 0, id);
    return result;
  }

  function groupSessionsByProject(items, { projectName, projectKey, sessionOrder = [], projectOrder = [] }) {
    const byProject = new Map();
    const keyOf = typeof projectKey === "function" ? projectKey : projectName;
    for (const session of items || []) {
      const key = String(keyOf(session) || "");
      const name = projectName(session);
      if (!key) continue;
      if (!byProject.has(key)) {
        byProject.set(key, { key, name, cwd: session.cwd, sessions: [] });
      }
      byProject.get(key).sessions.push(session);
    }

    const bySessionId = (session) => session.id;
    const groups = [...byProject.values()];
    for (const group of groups) {
      group.sessions = sortBySavedOrder(group.sessions, sessionOrder, bySessionId);
    }
    const groupKey = (group) => group.key || group.cwd || group.name;
    const recency = (left, right) =>
      String(right.sessions[0]?.updatedAt || "").localeCompare(
        String(left.sessions[0]?.updatedAt || ""),
      );
    const sorted = sortBySavedOrder(groups, projectOrder, groupKey);
    const known = sorted.filter((group) => projectOrder.includes(groupKey(group)));
    const unknown = sorted.filter((group) => !projectOrder.includes(groupKey(group))).sort(recency);
    return [...known, ...unknown];
  }

  /** Default conversations shown per project before "show more". */
  const PROJECT_SESSION_PREVIEW_LIMIT = 5;

  /**
   * Cap a project's session list. `limit <= 0` means unlimited (search / pinned).
   * If the active session sits past the fold, show the full list so the current
   * chat still highlights in the sidebar.
   */
  function previewProjectSessions(
    sessions,
    { limit = PROJECT_SESSION_PREVIEW_LIMIT, expanded = false, activeId = null } = {},
  ) {
    const list = Array.isArray(sessions) ? sessions : [];
    const cap = Number(limit);
    const unlimited = !Number.isFinite(cap) || cap <= 0;
    const overflow = !unlimited && list.length > cap;
    const activeIndex = activeId ? list.findIndex((session) => session.id === activeId) : -1;
    const forceAll = overflow && activeIndex >= cap;
    const showAll = unlimited || !overflow || expanded || forceAll;
    return {
      shown: showAll ? list : list.slice(0, cap),
      hidden: showAll ? 0 : list.length - cap,
      overflow,
      expanded: !!expanded,
      forceAll,
    };
  }

  global.GrokSidebarModel = {
    groupSessionsByProject,
    moveKey,
    promoteSidebarKey,
    promoteSessionOrder,
    sortBySavedOrder,
    previewProjectSessions,
    PROJECT_SESSION_PREVIEW_LIMIT,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

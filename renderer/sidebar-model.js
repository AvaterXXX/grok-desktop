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

  function groupSessionsByProject(
    items,
    { projectName, isWorking, sessionOrder = [], projectOrder = [] },
  ) {
    const byProject = new Map();
    for (const session of items || []) {
      const name = projectName(session);
      if (!byProject.has(name)) {
        byProject.set(name, { name, cwd: session.cwd, sessions: [] });
      }
      byProject.get(name).sessions.push(session);
    }

    const orderSessions = (sessions) => {
      const working = sessions.filter(isWorking);
      const idle = sessions.filter((session) => !isWorking(session));
      const bySessionId = (session) => session.id;
      return [
        ...sortBySavedOrder(working, sessionOrder, bySessionId),
        ...sortBySavedOrder(idle, sessionOrder, bySessionId),
      ];
    };

    const groups = [...byProject.values()];
    for (const group of groups) group.sessions = orderSessions(group.sessions);
    const workingGroups = groups.filter((group) => group.sessions.some(isWorking));
    const idleGroups = groups.filter((group) => !group.sessions.some(isWorking));
    const groupKey = (group) => group.cwd || group.name;
    const recency = (left, right) =>
      String(right.sessions[0]?.updatedAt || "").localeCompare(
        String(left.sessions[0]?.updatedAt || ""),
      );
    const orderGroups = (source) => {
      const sorted = sortBySavedOrder(source, projectOrder, groupKey);
      const known = sorted.filter((group) => projectOrder.includes(groupKey(group)));
      const unknown = sorted
        .filter((group) => !projectOrder.includes(groupKey(group)))
        .sort(recency);
      return [...known, ...unknown];
    };
    return [...orderGroups(workingGroups), ...orderGroups(idleGroups)];
  }

  global.GrokSidebarModel = {
    groupSessionsByProject,
    moveKey,
    sortBySavedOrder,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

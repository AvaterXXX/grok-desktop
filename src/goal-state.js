(function initGoalState(global) {
  function goalStatus(info) {
    return String(info?.status || "")
      .trim()
      .toLowerCase();
  }

  /** A terminal goal must never be resumed after reopening a session. */
  function isGoalTerminal(info) {
    if (info?.completed === true || info?.terminal === true || info?.cleared === true) return true;
    const status = goalStatus(info);
    const event = String(info?.lastEvent || info?.last_event || "")
      .trim()
      .toLowerCase();
    return (
      /^(?:complete|completed|done|success|succeeded|clear|cleared|cancelled|canceled|aborted|no_goal|not_set)$/.test(
        status,
      ) || /^(?:goal_completed|goal_cleared|goal_cancelled|goal_canceled|goal_aborted)$/.test(event)
    );
  }

  // Kept for callers that used the old name; `completed` is the persisted
  // compatibility flag for every terminal state, including an explicit clear.
  const isGoalComplete = isGoalTerminal;

  function isGoalPaused(info) {
    if (isGoalTerminal(info)) return false;
    const status = goalStatus(info);
    const event = String(info?.lastEvent || info?.last_event || "")
      .trim()
      .toLowerCase();
    return info?.paused === true || /paused$/.test(status) || event === "goal_paused";
  }

  function hasConcreteGoalIdentity(info) {
    if (!info || typeof info !== "object") return false;
    if (info.goalId || info.goal_id) return true;
    const objective = String(info.objective || info.label || "").trim();
    return !!objective && !/^(?:goal|resume|status)$/i.test(objective);
  }

  function isGoalRestorable(info) {
    return !!info && !isGoalTerminal(info) && hasConcreteGoalIdentity(info);
  }

  function isGoalAbsentReply(text) {
    return /^\s*(?:No goal set\b|Goal cleared\b)/i.test(String(text || ""));
  }

  function classifyGoalCommand(rawArgs) {
    const args = String(rawArgs || "").trim();
    if (!args || /^status$/i.test(args)) return "status";
    if (/^clear$/i.test(args)) return "clear";
    if (/^pause$/i.test(args)) return "pause";
    if (/^resume$/i.test(args)) return "resume";
    return "start";
  }

  function normalizeGoalState(info) {
    if (!info || typeof info !== "object") return null;
    const objective = String(info.objective || info.label || "").trim();
    const status = goalStatus(info) || (info.paused ? "user_paused" : "active");
    const terminal = isGoalTerminal({ ...info, status });
    return {
      kind: "goal",
      goalId: info.goalId || info.goal_id || null,
      label: objective || "goal",
      objective,
      status,
      phase: String(info.phase || "").trim() || null,
      paused: terminal ? false : isGoalPaused({ ...info, status }),
      completed: terminal,
      lastEvent: info.lastEvent || info.last_event || null,
      lastEventAt: info.lastEventAt || info.last_event_timestamp || null,
      savedAt: Number(info.savedAt) || Date.now(),
    };
  }

  const api = {
    classifyGoalCommand,
    goalStatus,
    hasConcreteGoalIdentity,
    isGoalAbsentReply,
    isGoalComplete,
    isGoalPaused,
    isGoalRestorable,
    isGoalTerminal,
    normalizeGoalState,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global) Reflect.set(global, "GrokGoalState", api);
})(typeof globalThis !== "undefined" ? globalThis : this);

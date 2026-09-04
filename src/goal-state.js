function goalStatus(info) {
  return String(info?.status || "")
    .trim()
    .toLowerCase();
}

function isGoalComplete(info) {
  if (info?.completed === true) return true;
  const status = goalStatus(info);
  const event = String(info?.lastEvent || info?.last_event || "")
    .trim()
    .toLowerCase();
  return (
    /^(?:complete|completed|done|success|succeeded)$/.test(status) || event === "goal_completed"
  );
}

function isGoalPaused(info) {
  if (isGoalComplete(info)) return false;
  const status = goalStatus(info);
  const event = String(info?.lastEvent || info?.last_event || "")
    .trim()
    .toLowerCase();
  return info?.paused === true || /paused$/.test(status) || event === "goal_paused";
}

function normalizeGoalState(info) {
  if (!info || typeof info !== "object") return null;
  const objective = String(info.objective || info.label || "").trim();
  const status = goalStatus(info) || (info.paused ? "user_paused" : "active");
  return {
    kind: "goal",
    goalId: info.goalId || info.goal_id || null,
    label: objective || "goal",
    objective,
    status,
    phase: String(info.phase || "").trim() || null,
    paused: isGoalPaused({ ...info, status }),
    completed: isGoalComplete({ ...info, status }),
    lastEvent: info.lastEvent || info.last_event || null,
    lastEventAt: info.lastEventAt || info.last_event_timestamp || null,
    savedAt: Number(info.savedAt) || Date.now(),
  };
}

module.exports = {
  goalStatus,
  isGoalComplete,
  isGoalPaused,
  normalizeGoalState,
};

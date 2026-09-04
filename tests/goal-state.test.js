const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { isGoalComplete, isGoalPaused, normalizeGoalState } = require("../src/goal-state");

test("normalizes active and paused ACP goal states", () => {
  const active = normalizeGoalState({
    goal_id: "g1",
    objective: "ship the fix",
    status: "active",
    last_event: "worker_completed",
  });
  assert.equal(active.goalId, "g1");
  assert.equal(active.label, "ship the fix");
  assert.equal(active.paused, false);
  assert.equal(active.completed, false);

  assert.equal(isGoalPaused({ status: "user_paused" }), true);
  assert.equal(isGoalPaused({ status: "infra_paused" }), true);
});

test("treats the protocol's complete state as terminal", () => {
  assert.equal(isGoalComplete({ completed: true, status: "active" }), true);
  assert.equal(isGoalComplete({ status: "complete" }), true);
  assert.equal(isGoalComplete({ status: "active", last_event: "goal_completed" }), true);
  assert.equal(normalizeGoalState({ objective: "done", status: "complete" }).completed, true);
});

test("latest protocol completion overrides a stale active sidecar", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-goal-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { loadSessionGoal, saveSessionGoal } = require("../src/sessions");
  saveSessionGoal(dir, { objective: "finish release", status: "active" });
  fs.writeFileSync(
    path.join(dir, "updates.jsonl"),
    `${JSON.stringify({
      timestamp: 1788400000,
      params: {
        update: {
          sessionUpdate: "goal_updated",
          objective: "finish release",
          status: "complete",
          last_event: "goal_completed",
        },
      },
    })}\n`,
  );
  const goal = loadSessionGoal(dir);
  assert.equal(goal.completed, true);
  assert.equal(goal.objective, "finish release");
});

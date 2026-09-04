const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  classifyGoalCommand,
  isGoalAbsentReply,
  isGoalComplete,
  isGoalPaused,
  isGoalRestorable,
  isGoalTerminal,
  normalizeGoalState,
} = require("../src/goal-state");

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

test("treats cleared goals as terminal and rejects command placeholders", () => {
  assert.equal(isGoalTerminal({ status: "cleared" }), true);
  assert.equal(isGoalTerminal({ last_event: "goal_cleared" }), true);
  assert.equal(normalizeGoalState({ status: "cleared" }).completed, true);
  assert.equal(isGoalRestorable({ objective: "ship release", status: "active" }), true);
  assert.equal(isGoalRestorable({ goal_id: "g2", status: "user_paused" }), true);
  assert.equal(isGoalRestorable({ objective: "goal", status: "active" }), false);
  assert.equal(isGoalRestorable({ objective: "resume", status: "active" }), false);
  assert.equal(isGoalRestorable({ objective: "ship release", status: "cleared" }), false);
  assert.equal(isGoalAbsentReply("No goal set. Use /goal <objective> to start one."), true);
  assert.equal(isGoalAbsentReply("Goal cleared."), true);
  assert.equal(isGoalAbsentReply("Goal is still active."), false);
  assert.equal(classifyGoalCommand(""), "status");
  assert.equal(classifyGoalCommand("status"), "status");
  assert.equal(classifyGoalCommand("clear"), "clear");
  assert.equal(classifyGoalCommand("pause"), "pause");
  assert.equal(classifyGoalCommand("resume"), "resume");
  assert.equal(classifyGoalCommand("finish the release"), "start");
});

test("latest protocol completion overrides a stale active sidecar", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-goal-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { loadSessionGoal, saveSessionGoal } = require("../src/sessions");
  saveSessionGoal(dir, {
    objective: "finish release",
    status: "active",
    savedAt: 1_788_399_000_000,
  });
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

test("explicit clear leaves a terminal tombstone that beats old active history", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-goal-clear-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { clearSessionGoal, loadSessionGoal, saveSessionGoal } = require("../src/sessions");
  fs.writeFileSync(
    path.join(dir, "updates.jsonl"),
    `${JSON.stringify({
      timestamp: 1_788_400_000,
      params: {
        update: {
          sessionUpdate: "goal_updated",
          goal_id: "old-goal",
          objective: "old objective",
          status: "active",
        },
      },
    })}\n`,
  );
  saveSessionGoal(dir, {
    goalId: "old-goal",
    objective: "old objective",
    status: "active",
    savedAt: 1_788_400_000_000,
  });

  clearSessionGoal(dir);
  const cleared = loadSessionGoal(dir);
  assert.equal(cleared.completed, true);
  assert.equal(cleared.status, "cleared");
  assert.equal(fs.existsSync(path.join(dir, "desktop-goal.json")), true);
});

test("legacy clear event wins over an earlier active goal", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-goal-legacy-clear-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { loadSessionGoal } = require("../src/sessions");
  fs.writeFileSync(
    path.join(dir, "updates.jsonl"),
    [
      JSON.stringify({
        timestamp: 1_788_400_000,
        params: {
          update: {
            sessionUpdate: "goal_updated",
            goal_id: "legacy-goal",
            objective: "legacy objective",
            status: "active",
          },
        },
      }),
      JSON.stringify({
        timestamp: 1_788_400_100,
        params: {
          update: { sessionUpdate: "user_message_chunk", content: { text: "/goal clear" } },
        },
      }),
    ].join("\n") + "\n",
  );

  const cleared = loadSessionGoal(dir);
  assert.equal(cleared.completed, true);
  assert.equal(cleared.status, "cleared");
});

test("new concrete goal can replace an older clear tombstone", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-goal-restart-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { clearSessionGoal, loadSessionGoal, saveSessionGoal } = require("../src/sessions");
  clearSessionGoal(dir, { terminalGoal: { status: "cleared", savedAt: 1000 } });
  saveSessionGoal(dir, {
    goalId: "new-goal",
    objective: "new objective",
    status: "active",
    savedAt: 2000,
  });

  const active = loadSessionGoal(dir);
  assert.equal(active.completed, false);
  assert.equal(active.goalId, "new-goal");
});

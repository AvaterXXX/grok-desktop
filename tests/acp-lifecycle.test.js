const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { AcpClient } = require("../src/acp");

function transport() {
  const client = new AcpClient({ cliPath: "grok", cwd: process.cwd() });
  const writes = [];
  let killed = false;
  client.sessionId = "s";
  client.started = true;
  client.proc = {
    stdin: { writable: true, write: (line) => writes.push(JSON.parse(line)) },
    kill: () => {
      killed = true;
    },
  };
  const activity = [];
  client.on("activity", ({ busy }) => activity.push(busy));
  return { client, writes, activity, killed: () => killed };
}

function update(client, value, meta = {}) {
  client.handleNotification("_x.ai/session/update", {
    sessionId: "s",
    update: value,
    _meta: meta,
  });
}

test("background completion wakes a tracked turn even without a desktop prompt", () => {
  const { client, activity } = transport();
  update(client, { sessionUpdate: "user_message_chunk", _meta: { syntheticPrompt: true } });
  assert.equal(client.isBusy(), true);
  update(
    client,
    { sessionUpdate: "agent_thought_chunk", content: { text: "checking" } },
    { promptId: "task-completed-t1" },
  );
  update(client, { sessionUpdate: "turn_completed", prompt_id: "old-host-command" });
  assert.equal(client.isBusy(), true);
  update(client, { sessionUpdate: "turn_completed", prompt_id: "task-completed-t1" });
  assert.equal(client.isBusy(), false);
  assert.deepEqual(activity, [true, false]);
  client.dispose();
});

test("a fast host command cannot mark a background run idle", async () => {
  const { client, writes } = transport();
  update(client, { sessionUpdate: "user_message_chunk", _meta: { syntheticPrompt: true } });
  const command = client.prompt("/goal status");
  const request = writes.at(-1);
  update(
    client,
    {
      sessionUpdate: "agent_message_chunk",
      content: { text: "status" },
      _meta: { hostTurn: true },
    },
    { promptId: "host-status" },
  );
  update(client, { sessionUpdate: "turn_completed", prompt_id: "host-status" });
  client.onLine(JSON.stringify({ id: request.id, result: { stopReason: "end_turn" } }));
  await command;
  assert.equal(client.isBusy(), true);
  update(
    client,
    { sessionUpdate: "agent_message_chunk", content: { text: "work" } },
    { promptId: "background" },
  );
  update(client, { sessionUpdate: "turn_completed", prompt_id: "background" });
  assert.equal(client.isBusy(), false);
  client.dispose();
});

test("suspend terminates the CLI and blocks late background wakeups", async () => {
  const { client, writes, killed } = transport();
  const chunks = [];
  client.on("messageChunk", (text) => chunks.push(text));
  const prompt = client.prompt("work");
  const rejected = assert.rejects(prompt, /disposed/);
  client.suspend();
  await rejected;
  assert.equal(killed(), true);
  assert.equal(writes.at(-1).method, "session/cancel");
  assert.equal(client.sessionId, "s");
  assert.equal(client.isBusy(), false);
  update(client, { sessionUpdate: "user_message_chunk", _meta: { syntheticPrompt: true } });
  update(client, { sessionUpdate: "agent_message_chunk", content: { text: "must not continue" } });
  assert.deepEqual(chunks, []);
  await assert.rejects(client.prompt("resume"), /suspended/);
});

test("loading history never starts a live background turn", () => {
  const { client, activity } = transport();
  client.hydrateMode = true;
  update(client, { sessionUpdate: "user_message_chunk", _meta: { syntheticPrompt: true } });
  update(client, { sessionUpdate: "agent_message_chunk", content: { text: "history" } });
  assert.deepEqual(activity, []);
  assert.equal(client.isBusy(), false);
  client.dispose();
});

test("model and effort can change while suspended without restarting work", async () => {
  const { client, writes } = transport();
  client.suspend();
  const before = writes.length;
  await client.setModel("grok-4.7-build-fast");
  await client.setEffort("high");
  assert.equal(writes.length, before);
  assert.equal(client.currentModelId, "grok-4.7-build-fast");
  assert.equal(client.currentEffort, "high");
  assert.equal(client.suspended, true);
});

function sourceAst(file) {
  return ts.createSourceFile(
    file,
    fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

test("goal clear IPC suspends its runtime after the host acknowledgement", async () => {
  const source = sourceAst("main.js");
  const handler = source.statements.find((node) =>
    node.getText(source).startsWith('handleIpc("session:run-slash",'),
  );
  const { client, writes, killed } = transport();
  const sent = [];
  let run;
  const context = vm.createContext({
    handleIpc: (_name, fn) => {
      run = fn;
    },
    activeSessionId: "s",
    activeSessionMeta: null,
    getAgent: () => client,
    getAgentEntry: () => ({ client }),
    findSession: () => null,
    send: (channel, payload) => sent.push({ channel, payload }),
    ...require("../src/goal-state"),
  });
  vm.runInContext(handler.getText(source), context);
  const request = run(null, { sessionId: "s", command: "goal", args: "clear" });
  const pending = writes.at(-1);
  assert.equal(pending.params.prompt[0].text, "/goal clear");
  update(client, {
    sessionUpdate: "agent_message_chunk",
    content: { text: "Goal cleared." },
    _meta: { hostTurn: true },
  });
  client.onLine(JSON.stringify({ id: pending.id, result: {} }));
  await request;
  assert.equal(killed(), true);
  assert.equal(client.suspended, true);
  assert.equal(sent.find((x) => x.channel === "session:goal").payload.status, "cleared");
});

test("the next explicit prompt reconnects a suspended session exactly once", async (t) => {
  const source = sourceAst("main.js");
  const handler = source.statements.find((node) =>
    node.getText(source).startsWith('handleIpc("session:prompt",'),
  );
  const stopped = transport().client;
  stopped.suspend();
  const fresh = transport();
  t.after(() => fresh.client.dispose());
  const entry = { client: stopped, busy: false };
  let run;
  let reconnects = 0;
  const context = vm.createContext({
    handleIpc: (_name, fn) => {
      run = fn;
    },
    activeSessionId: "s",
    activeSessionMeta: null,
    getAgent: () => entry.client,
    getAgentEntry: () => entry,
    reviveAgent: async () => {
      reconnects++;
      entry.client = fresh.client;
      return fresh.client;
    },
    touchAgent: () => {},
    send: () => {},
  });
  vm.runInContext(handler.getText(source), context);
  const sent = run(null, { sessionId: "s", text: "a new user request" });
  await new Promise((resolve) => setImmediate(resolve));
  const request = fresh.writes.at(-1);
  assert.equal(request.params.prompt[0].text, "a new user request");
  fresh.client.onLine(JSON.stringify({ id: request.id, result: {} }));
  assert.equal((await sent).ok, true);
  assert.equal(reconnects, 1);
  fresh.client.dispose();
});

test("busy chrome and the idle timer honor authoritative background activity", () => {
  const source = sourceAst("renderer/app.js");
  const st = { agentBusy: true, replyIdle: true };
  const context = vm.createContext({
    sessionUi: new Map([["s", st]]),
    workingSessions: new Set(),
    promptInFlight: new Set(),
  });
  for (const name of ["sessionVisuallyBusy", "settleLiveReply"]) {
    const fn = source.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    vm.runInContext(fn.getText(source), context);
  }
  assert.equal(vm.runInContext('sessionVisuallyBusy("s")', context), true);
  // The timer must return before rendering/finalizing a still-active turn.
  vm.runInContext('settleLiveReply("s", {force:true})', context);
  st.agentBusy = false;
  assert.equal(vm.runInContext('sessionVisuallyBusy("s")', context), false);
});

test("background activity changes the empty composer's send button to Stop", () => {
  const source = sourceAst("renderer/app.js");
  const st = { agentBusy: true, replyIdle: true };
  const classes = new Set();
  const send = {
    disabled: true,
    setAttribute: () => {},
    classList: {
      add: (...names) => names.forEach((x) => classes.add(x)),
      remove: (...names) => names.forEach((x) => classes.delete(x)),
    },
  };
  const context = vm.createContext({
    activeId: "s",
    sessionUi: new Map([["s", st]]),
    workingSessions: new Set(),
    promptInFlight: new Set(),
    ui: { send, input: { value: "" } },
    pendingImages: [],
    pendingFiles: [],
    connecting: false,
    composerMode: "task",
    $: () => null,
  });
  for (const name of ["sessionVisuallyBusy", "isAgentBusy", "refreshSendButtonState"]) {
    const fn = source.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    vm.runInContext(fn.getText(source), context);
  }
  vm.runInContext("refreshSendButtonState()", context);
  assert.equal(send.disabled, false);
  assert.equal(classes.has("stop-mode"), true);
  st.agentBusy = false;
  vm.runInContext("refreshSendButtonState()", context);
  assert.equal(send.disabled, true);
  assert.equal(classes.has("stop-mode"), false);
});

test("stop after clear does not invent a paused goal over the clear tombstone", () => {
  const source = sourceAst("renderer/app.js");
  const fn = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "abortGoalResume",
  );
  const st = {};
  let saved = false;
  const context = vm.createContext({
    activeId: "s",
    ensureSessionUi: () => st,
    sessionAutomation: new Map(),
    setSessionAutomation: () => {
      saved = true;
    },
    ...require("../src/goal-state"),
  });
  vm.runInContext(fn.getText(source), context);
  vm.runInContext('abortGoalResume("s", {pause:true})', context);
  assert.equal(saved, false);
  assert.equal(st.skipGoalResume, true);
});

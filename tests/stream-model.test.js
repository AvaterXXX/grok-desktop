const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canAppendAssistantChunk,
  canAppendThoughtChunk,
  canContinueHistoryThoughtBlock,
  canReuseAssistantStream,
  createStreamBuffer,
  drainStreamSegments,
  enqueueStreamSegment,
  finalizeThoughtText,
  hasVisibleStreamText,
  hasPendingStream,
  pendingStreamLength,
  shouldIgnoreOrphanStreamChunk,
  streamBoundaryPolicy,
} = require("../renderer/stream-model");

test("stream buffer merges only adjacent chunks and retains event order", () => {
  const buffer = createStreamBuffer();
  enqueueStreamSegment(buffer, "thought", "plan ");
  enqueueStreamSegment(buffer, "thought", "one");
  enqueueStreamSegment(buffer, "assistant", "working");
  enqueueStreamSegment(buffer, "thought", "plan two");

  assert.equal(hasPendingStream(buffer), true);
  assert.equal(pendingStreamLength(buffer), 23);
  assert.deepEqual(drainStreamSegments(buffer), [
    { kind: "thought", text: "plan one" },
    { kind: "assistant", text: "working" },
    { kind: "thought", text: "plan two" },
  ]);
  assert.equal(hasPendingStream(buffer), false);
});

test("thought tokens stay in one block when tools appear inside it", () => {
  assert.equal(
    canAppendThoughtChunk({
      connected: true,
      samePane: true,
      done: false,
      afterLastUser: true,
    }),
    true,
  );
  assert.equal(
    canAppendThoughtChunk({ connected: true, samePane: true, done: true, afterLastUser: true }),
    false,
  );
});

test("assistant tokens stay in one turn when unrelated DOM nodes appear after it", () => {
  assert.equal(
    canAppendAssistantChunk({
      connected: true,
      kind: "assistant",
      insideThought: false,
      afterLastUser: true,
    }),
    true,
  );
  assert.equal(
    canAppendAssistantChunk({
      connected: true,
      kind: "assistant",
      insideThought: true,
      afterLastUser: true,
    }),
    false,
  );
});

test("live assistant target survives transient neighboring DOM updates", () => {
  assert.equal(
    canReuseAssistantStream({
      connected: true,
      samePane: true,
      assistant: true,
      bodyOwned: true,
      kind: "assistant",
    }),
    true,
  );
  assert.equal(
    canReuseAssistantStream({
      connected: true,
      samePane: false,
      assistant: true,
      bodyOwned: true,
      kind: "assistant",
    }),
    false,
  );
});

test("standalone whitespace does not create an empty thought or assistant card", () => {
  assert.equal(hasVisibleStreamText("   \n"), false);
  assert.equal(hasVisibleStreamText(" next token"), true);
  assert.equal(shouldIgnoreOrphanStreamChunk(false, " \n"), true);
  assert.equal(shouldIgnoreOrphanStreamChunk(true, " \n"), false);
  assert.equal(shouldIgnoreOrphanStreamChunk(false, "content"), false);
});

test("thought finalization preserves the exact received content", () => {
  assert.deepEqual(finalizeThoughtText("1. complete\n\n4."), {
    text: "1. complete\n\n4.",
    interrupted: false,
  });
  assert.deepEqual(finalizeThoughtText('```python\n"url": "https://example.test/v1.'), {
    text: '```python\n"url": "https://example.test/v1.',
    interrupted: false,
  });
  assert.deepEqual(finalizeThoughtText("This sentence is complete."), {
    text: "This sentence is complete.",
    interrupted: false,
  });
});

test("interleaved thought and message tokens never close each other", () => {
  // The live stream alternates thought and message tokens within one turn.
  // Each close+reopen cycle used to mint a fresh 0.1s thought block and a
  // one-fragment bubble per token, so neither text stream may close the other.
  for (const kind of ["thought.chunk", "assistant.chunk"]) {
    assert.deepEqual(streamBoundaryPolicy(kind), {
      closesThought: false,
      closesAssistant: false,
      nestsToolsInThought: false,
    });
  }
});

test("tool steps nest inside the thought while no assistant text is live", () => {
  const nested = streamBoundaryPolicy("tool", { hasLiveAssistantBody: false });
  assert.equal(nested.closesThought, false);
  assert.equal(nested.nestsToolsInThought, true);
  assert.equal(nested.closesAssistant, true);
  const sameForDiffAndPermission = ["diff", "permission"].every((event) => {
    const p = streamBoundaryPolicy(event, { hasLiveAssistantBody: false });
    return p.closesThought === false && p.nestsToolsInThought === true;
  });
  assert.equal(sameForDiffAndPermission, true);
});

test("tool steps settle the thought once assistant text already streamed", () => {
  const boundary = streamBoundaryPolicy("tool", { hasLiveAssistantBody: true });
  assert.equal(boundary.closesThought, true);
  assert.equal(boundary.nestsToolsInThought, false);
  assert.equal(boundary.closesAssistant, true);
});

test("user turns and run end close both surfaces", () => {
  for (const event of ["user", "run.end"]) {
    const boundary = streamBoundaryPolicy(event);
    assert.equal(boundary.closesThought, true, event);
    assert.equal(boundary.closesAssistant, true, event);
    assert.equal(boundary.nestsToolsInThought, false, event);
  }
});

test("replayed thoughts merge only into a block nothing has rendered after", () => {
  // Mid-turn thoughts must stay between the messages they belong to: once an
  // assistant turn or top-level tool group renders after a block, the next
  // thought starts a fresh block in place instead of merging into the old one.
  assert.equal(
    canContinueHistoryThoughtBlock({ connected: true, inPane: true, isLastElement: true }),
    true,
  );
  assert.equal(
    canContinueHistoryThoughtBlock({ connected: true, inPane: true, isLastElement: false }),
    false,
  );
  assert.equal(
    canContinueHistoryThoughtBlock({ connected: false, inPane: true, isLastElement: true }),
    false,
  );
  assert.equal(
    canContinueHistoryThoughtBlock({ connected: true, inPane: false, isLastElement: true }),
    false,
  );
});

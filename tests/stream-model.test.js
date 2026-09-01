const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canAppendAssistantChunk,
  canAppendThoughtChunk,
  createStreamBuffer,
  drainStreamSegments,
  enqueueStreamSegment,
  hasVisibleStreamText,
  hasPendingStream,
  pendingStreamLength,
  shouldIgnoreOrphanStreamChunk,
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

test("thought tokens stay in one block when unrelated DOM nodes appear after it", () => {
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

test("standalone whitespace does not create an empty thought or assistant card", () => {
  assert.equal(hasVisibleStreamText("   \n"), false);
  assert.equal(hasVisibleStreamText(" next token"), true);
  assert.equal(shouldIgnoreOrphanStreamChunk(false, " \n"), true);
  assert.equal(shouldIgnoreOrphanStreamChunk(true, " \n"), false);
  assert.equal(shouldIgnoreOrphanStreamChunk(false, "content"), false);
});

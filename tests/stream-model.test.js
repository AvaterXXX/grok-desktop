const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createStreamBuffer,
  drainStreamSegments,
  enqueueStreamSegment,
  hasPendingStream,
  pendingStreamLength,
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

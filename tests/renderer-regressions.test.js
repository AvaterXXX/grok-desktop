const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

/**
 * Structural guarantees for the two user-visible regressions that are not
 * reachable from a pure unit test: a sent message disappearing, and the pinned
 * question bar forcing layout on every frame.
 *
 * These assert *ordering* and *shape* in the shipped renderer source, because
 * the bug in both cases was where a statement sat relative to an `await`.
 */
const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");

function functionSource(name) {
  const source = ts.createSourceFile(
    "app.js",
    appSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const node = source.statements.find(
    (item) => ts.isFunctionDeclaration(item) && item.name?.text === name,
  );
  assert.ok(node, `missing function ${name}`);
  return node.getText(source);
}

test("sendNow claims the session before its first await", () => {
  // The `\call` forwarding prologue runs before the target is resolved and is a
  // separate concern; the claim ordering applies to the real send path.
  const body = functionSource("sendNow");
  const start = body.indexOf("const sentTo = sessionId || activeId;");
  assert.ok(start >= 0, "sendNow must resolve the target session");
  const sendPath = body.slice(start);
  const claimAt = sendPath.indexOf("promptInFlight.add(sentTo)");
  const firstAwaitAt = sendPath.indexOf("await ");
  assert.ok(claimAt >= 0, "sendNow must claim the turn");
  assert.ok(firstAwaitAt >= 0, "sendNow is expected to await later steps");
  assert.ok(
    claimAt < firstAwaitAt,
    "promptInFlight must be set before any await, otherwise a concurrent " +
      "history load can clear the thread and delete the user's bubble",
  );
});

test("the user bubble is painted before the send awaits anything", () => {
  const body = functionSource("sendNow");
  const start = body.indexOf("const sentTo = sessionId || activeId;");
  const sendPath = body.slice(start);
  const paintAt = sendPath.indexOf('appendTurn("user"');
  const firstAwaitAt = sendPath.indexOf("await ");
  assert.ok(paintAt >= 0, "sendNow must paint the user turn");
  assert.ok(
    paintAt < firstAwaitAt,
    "the user's own message must appear before image reads / connecting / " +
      "renaming, so it can never be dropped by a later repaint",
  );
});

test("sending while a session is still loading queues instead of dropping", () => {
  const body = functionSource("send");
  const guardAt = body.indexOf("if (connecting && !isAgentBusy(activeId)");
  assert.ok(guardAt >= 0, "send() keeps the connecting guard");
  const guarded = body.slice(guardAt, guardAt + 700);
  assert.ok(
    guarded.includes("enqueueFollowUp"),
    "the connecting guard must queue the message, not return silently",
  );
});

test("the send button is disabled while a session is connecting", () => {
  // The composer is the other half of the same contract: if Enter now queues,
  // the button must not look like a no-op either.
  const body = functionSource("refreshSendButtonState");
  assert.match(
    body,
    /connecting|connecting:\s*true|isConnecting/,
    "refreshSendButtonState must account for the connecting state",
  );
});

test("a failed connect releases the turn claim", () => {
  const body = functionSource("sendNow");
  const connectAt = body.indexOf("await ensureSessionConnected(sentTo)");
  assert.ok(connectAt >= 0, "sendNow connects on demand");
  const around = body.slice(connectAt, connectAt + 900);
  assert.ok(
    around.includes("releaseFailedSend"),
    "a connect failure must release promptInFlight, otherwise the session " +
      "stays permanently 'sending' and its queue never drains",
  );

  const release = functionSource("releaseFailedSend");
  for (const step of [
    "promptInFlight.delete(sentTo)",
    "workingSessions.delete(sentTo)",
    "markRunEnd(sentTo)",
    "refreshSendButtonState()",
  ]) {
    assert.ok(release.includes(step), `releaseFailedSend must ${step}`);
  }
});

test("the pinned prompt bar measures at most once per frame", () => {
  const body = functionSource("refreshPinnedPrompt");
  assert.ok(
    body.includes("requestAnimationFrame"),
    "refreshPinnedPrompt must coalesce measurements into one frame",
  );
  assert.ok(
    !body.includes("getBoundingClientRect"),
    "measurement belongs to the rAF paint step, not the scroll handler",
  );

  const paint = functionSource("paintPinnedPrompt");
  const rectCalls = (paint.match(/getBoundingClientRect/g) || []).length;
  assert.ok(
    rectCalls <= 2,
    `paintPinnedPrompt should take one thread rect and one per turn, saw ${rectCalls}`,
  );
  assert.ok(paint.includes("break"), "the scan must stop below the fold");
});

test("history paging only renders the new page", () => {
  const body = functionSource("queueEarlierHistoryPage");
  assert.ok(
    body.includes("renderHistoryRange"),
    "paging must render a range, not re-render the whole window",
  );
  assert.ok(
    !/clearThread\(\)/.test(body),
    "paging must not clear the thread: that discarded the DOM being read",
  );
  assert.ok(
    body.includes("insertBefore"),
    "the new page must be prepended to the existing nodes",
  );
});

test("the sidebar rebuilds only on structural change", () => {
  const body = functionSource("renderSidebar");
  assert.ok(
    body.includes("sessionSidebarSignature"),
    "renderSidebar must compare a structural fingerprint before rebuilding",
  );
  const sig = functionSource("sessionSidebarSignature");
  assert.ok(
    sig.includes("sessionOrderList"),
    "display order is part of the layout, so it belongs in the fingerprint",
  );
  assert.ok(
    !sig.includes("sessionVisuallyBusy"),
    "run state is painted in place and must not trigger a full rebuild",
  );
});

test("scrollToLastUserPrompt keeps following the stream", () => {
  const intoView = functionSource("scrollTurnIntoView");
  assert.match(
    intoView,
    /sticky = true/,
    "opening or sending must default to sticky follow",
  );
  const jump = functionSource("scrollToPinnedPrompt");
  assert.ok(
    jump.includes("sticky: false"),
    "jumping to an old question is the one case that stops following",
  );
});

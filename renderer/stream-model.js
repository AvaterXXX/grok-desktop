(function (global, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.GrokStreamModel = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function createStreamBuffer() {
    return { segments: [] };
  }

  function streamSegments(buffer) {
    if (!buffer || typeof buffer !== "object") return [];
    if (!Array.isArray(buffer.segments)) buffer.segments = [];
    return buffer.segments;
  }

  function enqueueStreamSegment(buffer, kind, text) {
    const value = String(text || "");
    if (!value) return buffer;
    const normalizedKind = kind === "thought" ? "thought" : "assistant";
    const segments = streamSegments(buffer);
    const last = segments[segments.length - 1];
    if (last?.kind === normalizedKind) last.text += value;
    else segments.push({ kind: normalizedKind, text: value });
    return buffer;
  }

  function drainStreamSegments(buffer) {
    const segments = streamSegments(buffer).splice(0);
    return segments.filter((segment) => segment?.text);
  }

  function hasPendingStream(buffer) {
    return streamSegments(buffer).some((segment) => !!segment?.text);
  }

  function pendingStreamLength(buffer) {
    return streamSegments(buffer).reduce(
      (total, segment) => total + String(segment?.text || "").length,
      0,
    );
  }

  /**
   * A live DOM reference is the stream target. Assistant/user events close it;
   * tool steps may stay nested inside it and must not become a boundary.
   * @param {{ connected?: boolean, samePane?: boolean, done?: boolean, afterLastUser?: boolean }} [state]
   */
  function canAppendThoughtChunk({ connected, samePane, done, afterLastUser } = {}) {
    return connected === true && samePane === true && done !== true && afterLastUser === true;
  }

  /**
   * @param {{ connected?: boolean, kind?: string, insideThought?: boolean, afterLastUser?: boolean }} [state]
   */
  function canAppendAssistantChunk({ connected, kind, insideThought, afterLastUser } = {}) {
    return (
      connected === true && kind === "assistant" && insideThought !== true && afterLastUser === true
    );
  }

  /**
   * A live assistant body can be reused when its ownership is still intact.
   * Timeline checks belong to semantic boundary handlers; applying them to
   * every token makes a transient neighboring DOM update split one reply.
   * @param {{ connected?: boolean, samePane?: boolean, assistant?: boolean, bodyOwned?: boolean, kind?: string }} [state]
   */
  function canReuseAssistantStream({ connected, samePane, assistant, bodyOwned, kind } = {}) {
    return (
      connected === true &&
      samePane === true &&
      assistant === true &&
      bodyOwned === true &&
      kind === "assistant"
    );
  }

  function hasVisibleStreamText(text) {
    return /\S/.test(String(text || ""));
  }

  function shouldIgnoreOrphanStreamChunk(hasTarget, text) {
    return !hasTarget && !hasVisibleStreamText(text);
  }

  function finalizeThoughtText(text) {
    return { text: String(text || "").replace(/\s+$/, ""), interrupted: false };
  }

  /**
   * Which stream events may close the live assistant bubble or the thought
   * disclosure. The upstream stream interleaves thought and message tokens
   * inside one turn, so neither text stream may close the other: every
   * close+reopen cycle mints a fresh 0.1-second thought block and a
   * one-fragment bubble per token. Only timeline boundaries close either
   * surface: a user turn, the end of the run, or a tool/permission/diff step
   * (those nest inside the disclosure while no assistant text is live, and
   * settle it top-level once text already streamed).
   * @param {string} event "thought.chunk" | "assistant.chunk" | "user" | "tool" | "permission" | "diff" | "run.end"
   * @param {{ hasLiveAssistantBody?: boolean }} [state]
   */
  function streamBoundaryPolicy(event, { hasLiveAssistantBody = false } = {}) {
    const step = event === "tool" || event === "permission" || event === "diff";
    const boundary = event === "user" || event === "run.end" || step;
    return {
      closesThought:
        event === "user" || event === "run.end" || (step && hasLiveAssistantBody === true),
      closesAssistant: boundary,
      nestsToolsInThought: step && hasLiveAssistantBody !== true,
    };
  }

  /**
   * A replayed thought block can only absorb the next thought segment while
   * it is still the newest node in the pane. Once an assistant turn or a
   * top-level tool group has rendered after it, the timeline moved on and the
   * next thought must start a fresh block in place — merging across that gap
   * hoists all mid-turn reasoning above the messages it belongs between.
   * @param {{ connected?: boolean, inPane?: boolean, isLastElement?: boolean }} [state]
   */
  function canContinueHistoryThoughtBlock({ connected, inPane, isLastElement } = {}) {
    return connected === true && inPane === true && isLastElement === true;
  }

  return {
    canAppendAssistantChunk,
    canContinueHistoryThoughtBlock,
    canReuseAssistantStream,
    canAppendThoughtChunk,
    createStreamBuffer,
    drainStreamSegments,
    enqueueStreamSegment,
    hasVisibleStreamText,
    hasPendingStream,
    pendingStreamLength,
    finalizeThoughtText,
    shouldIgnoreOrphanStreamChunk,
    streamBoundaryPolicy,
  };
});

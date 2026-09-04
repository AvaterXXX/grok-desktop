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

  return {
    canAppendAssistantChunk,
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
  };
});

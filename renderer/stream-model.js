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
   * A live DOM reference is the stream target. Tool/message/user events close
   * that target explicitly; unrelated status DOM must not become a boundary.
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

  function hasVisibleStreamText(text) {
    return /\S/.test(String(text || ""));
  }

  function shouldIgnoreOrphanStreamChunk(hasTarget, text) {
    return !hasTarget && !hasVisibleStreamText(text);
  }

  /**
   * Grok can stop a thought mid-line when it switches to a tool call. The
   * missing suffix was never sent, so preserve the received text while making
   * that upstream interruption explicit instead of showing a blank list item
   * or a line that appears visually clipped.
   */
  function finalizeThoughtText(text) {
    const raw = String(text || "").replace(/\s+$/, "");
    if (!raw) return { text: "", interrupted: false };

    const lines = raw.split("\n");
    const last = lines[lines.length - 1].trim();
    const danglingListMarker = /^(?:[-*+]\s*|\d+[.)]\s*)$/.test(last);
    if (danglingListMarker) {
      lines.pop();
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      const body = lines.join("\n").replace(/\s+$/, "");
      return { text: body ? `${body}\n\n…` : "…", interrupted: true };
    }

    const fenceCount = (raw.match(/```/g) || []).length;
    const unclosedFence = fenceCount % 2 === 1;
    const unfinishedUrl = /https?:\/\/\S*[\w/.-]$/i.test(last);
    const unfinishedClause = /(?:[,;:：，、]|\b(?:and|or|to|with|for|of|the))$/i.test(last);
    const interrupted = unclosedFence || unfinishedUrl || unfinishedClause;
    if (!interrupted || /…$/.test(raw)) return { text: raw, interrupted };
    return { text: `${raw}…`, interrupted: true };
  }

  return {
    canAppendAssistantChunk,
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

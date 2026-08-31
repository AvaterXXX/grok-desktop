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

  return {
    createStreamBuffer,
    drainStreamSegments,
    enqueueStreamSegment,
    hasPendingStream,
    pendingStreamLength,
  };
});

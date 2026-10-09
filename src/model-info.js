(function initModelInfo(global) {
  // Official rates verified 2026-10-02. Fast is a Build/Cursor speed tier.
  // https://docs.x.ai/developers/release-notes (September 21, 2026)
  const MODELS = {
    "grok-4.5": { context: 500000, input: 2, cache: 0.3, output: 6 },
    "grok-4.6": { context: 500000, input: 2, cache: 0.5, output: 6 },
    "grok-4.7": { context: 500000, input: 2, cache: 0.5, output: 6 },
    "grok-4.7-fast": { context: 500000, input: 4, cache: 1, output: 12 },
  };

  function modelFamilyOf(id) {
    const value = String(id || "").trim();
    const version = value.match(/\bgrok[-_ ]?4[.\-_ ]([567])(?:\b|_)/i);
    if (!version) return value || "unknown";
    const family = `grok-4.${version[1]}`;
    const fast = /(?:^|[-_ .])fast(?:$|[-_ .?])/i.test(value);
    return fast ? `${family}-fast` : family;
  }

  function numberOrNull(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) value = value.val;
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && !value.trim()) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function modelContextSize(id, entry = null) {
    for (const node of [entry, entry?._meta]) {
      for (const key of [
        "contextWindowTokens",
        "context_window_tokens",
        "contextWindow",
        "contextLength",
        "context_length",
        "maxContextTokens",
      ]) {
        const size = numberOrNull(node?.[key]);
        if (size > 0) return size;
      }
    }
    return MODELS[modelFamilyOf(id)]?.context || null;
  }

  function apiRatesForModel(id, promptTokens = 0) {
    const name = modelFamilyOf(id);
    const base = MODELS[name];
    if (!base) return null;
    const longContext = numberOrNull(promptTokens) > 200000;
    // Fast long context is 1.5x the standard long-context rate, not 2x.
    const multiplier = longContext ? (name === "grok-4.7-fast" ? 1.5 : 2) : 1;
    return {
      name,
      input: base.input * multiplier,
      cache: base.cache * multiplier,
      output: base.output * multiplier,
      longContext,
    };
  }

  function estimateApiUsd({
    input = 0,
    output = 0,
    cache = 0,
    reasoning = 0,
    promptTokens = 0,
    modelId = "",
  } = {}) {
    const inAll = numberOrNull(input) || 0;
    const rates = apiRatesForModel(modelId, Math.max(inAll, numberOrNull(promptTokens) || 0));
    if (!rates) return null;
    const cached = Math.min(numberOrNull(cache) || 0, inAll);
    return (
      ((inAll - cached) * rates.input +
        cached * rates.cache +
        ((numberOrNull(output) || 0) + (numberOrNull(reasoning) || 0)) * rates.output) /
      1e6
    );
  }

  const api = { apiRatesForModel, estimateApiUsd, modelContextSize, modelFamilyOf, numberOrNull };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global) Reflect.set(global, "GrokModelInfo", api);
})(typeof globalThis !== "undefined" ? globalThis : this);

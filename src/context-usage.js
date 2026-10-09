(function initContextUsage(global) {
  const modelInfo =
    typeof module !== "undefined" && module.exports
      ? require("./model-info")
      : Reflect.get(global, "GrokModelInfo");
  const { modelContextSize, numberOrNull } = modelInfo;

  function contextUsageFromPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const firstNumber = (keys, positive = false) => {
      for (const key of keys) {
        const value = numberOrNull(payload[key]);
        if (value != null && (!positive || value > 0)) return value;
      }
      return null;
    };
    const used = firstNumber(["contextTokensUsed", "context_tokens_used", "used"]);
    const size = firstNumber(["contextWindowTokens", "context_window_tokens", "size"], true);
    if (used == null && !(size > 0)) return null;
    const modelId = payload.modelId || payload.model;
    return {
      used,
      size: size > 0 ? size : null,
      estimated: false,
      ...(typeof modelId === "string" && modelId ? { modelId } : {}),
    };
  }

  function estimateContextTokens(chars) {
    return Math.ceil((numberOrNull(chars) || 0) / 4);
  }

  /** Measurements belong to one session; runtime capacity also belongs to its model. */
  function normalizeContextUsage(usage, previous, { modelId = "", modelEntry = null } = {}) {
    const prev = previous || {};
    modelId = modelId || usage?.modelId || prev.modelId || "";
    const sameModel = !prev.modelId || prev.modelId === modelId;
    const measured = numberOrNull(usage?.used);
    const priorUsed = numberOrNull(prev.used);
    const retainMeasured =
      sameModel && usage?.estimated === true && prev.estimated === false && priorUsed != null;
    const used = retainMeasured || measured == null ? priorUsed || 0 : measured;
    const incomingSize = numberOrNull(usage?.size);
    const runtimeSize = usage?.estimated !== true && incomingSize > 0 ? incomingSize : null;
    const priorSize = numberOrNull(prev.size);
    const savedRuntimeSize =
      sameModel && prev.sizeSource === "runtime" && priorSize > 0 ? priorSize : null;
    const size = runtimeSize || savedRuntimeSize || modelContextSize(modelId, modelEntry);
    return {
      ...prev,
      ...usage,
      used,
      size,
      modelId,
      sizeSource: runtimeSize || savedRuntimeSize ? "runtime" : "model",
      estimated:
        retainMeasured || measured == null
          ? sameModel
            ? (prev.estimated ?? false)
            : priorUsed != null
          : usage?.estimated === true,
    };
  }

  const api = { contextUsageFromPayload, estimateContextTokens, normalizeContextUsage };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global) Reflect.set(global, "GrokContextUsage", api);
})(typeof globalThis !== "undefined" ? globalThis : this);

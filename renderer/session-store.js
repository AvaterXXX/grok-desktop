(function (global, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.GrokSessionState = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function isTerminalToolStatus(status) {
    return /complete|ok|success|failed|error|cancel|done|reject|denied/.test(
      String(status || "").toLowerCase(),
    );
  }

  function createSessionModel(sessionId) {
    return {
      sessionId,
      phase: "ready",
      detail: "就绪",
      thoughtText: "",
      assistantText: "",
      assistantStepBoundary: false,
      tools: new Map(),
      toolOrder: [],
      revision: 0,
    };
  }

  function reduceSessionModel(previous, event) {
    const state = previous || createSessionModel(event?.sessionId || "");
    const next = {
      ...state,
      tools: new Map(state.tools || []),
      toolOrder: [...(state.toolOrder || [])],
      revision: (state.revision || 0) + 1,
    };
    const type = String(event?.type || "");

    if (type === "turn.start") {
      next.phase = "working";
      next.detail = event.detail || "";
      next.thoughtText = "";
      next.assistantText = "";
      next.assistantStepBoundary = false;
      next.tools = new Map();
      next.toolOrder = [];
    } else if (type === "thought.chunk") {
      next.thoughtText += String(event.text || "");
    } else if (type === "assistant.chunk") {
      const chunk = String(event.text || "");
      if (next.assistantStepBoundary && next.assistantText) {
        if (!/\s$/.test(next.assistantText) && !/^\s/.test(chunk)) next.assistantText += "\n\n";
      }
      next.assistantStepBoundary = false;
      next.assistantText += chunk;
    } else if (type === "tool.start" || type === "tool.update") {
      const tool = event.tool || {};
      const id = tool.toolCallId || event.toolCallId;
      if (id) {
        const prior = next.tools.get(id) || {};
        const merged = { ...prior };
        for (const [key, value] of Object.entries(tool)) {
          if (value == null) continue;
          if (
            key === "status" &&
            isTerminalToolStatus(prior.status) &&
            !isTerminalToolStatus(value)
          ) {
            continue;
          }
          merged[key] = value;
        }
        next.tools.set(id, merged);
        if (!next.toolOrder.includes(id)) next.toolOrder.push(id);
      }
      if (type === "tool.start" && next.assistantText) next.assistantStepBoundary = true;
    } else if (type === "run.finish" || type === "run.stop") {
      const failed = event.state === "error" || event.state === "disconnected";
      const stopped = type === "run.stop" || event.state === "cancelled";
      const status = stopped ? "cancelled" : failed ? "failed" : "completed";
      next.phase = failed ? "error" : "ready";
      next.detail = event.detail || next.detail;
      next.tools = new Map(
        [...next.tools].map(([id, tool]) => [
          id,
          isTerminalToolStatus(tool.status) ? tool : { ...tool, status },
        ]),
      );
    } else if (type === "status") {
      next.phase = event.state || next.phase;
      next.detail = event.detail || next.detail;
    } else if (type === "hydrate") {
      next.thoughtText = String(event.thoughtText || "");
      next.assistantText = String(event.assistantText || "");
      next.phase = event.phase || "ready";
    }
    return next;
  }

  class SessionStore {
    constructor(createViewState) {
      this.states = new Map();
      this.createViewState = createViewState || (() => ({}));
    }

    ensure(sessionId) {
      if (!sessionId) return null;
      if (!this.states.has(sessionId)) {
        this.states.set(sessionId, {
          ...this.createViewState(sessionId),
          model: createSessionModel(sessionId),
        });
      }
      return this.states.get(sessionId);
    }

    dispatch(sessionId, event) {
      const state = this.ensure(sessionId);
      if (!state) return null;
      state.model = reduceSessionModel(state.model, { ...event, sessionId });
      return state;
    }
  }

  return {
    SessionStore,
    createSessionModel,
    reduceSessionModel,
    isTerminalToolStatus,
  };
});

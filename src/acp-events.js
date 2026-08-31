/**
 * Convert the ACP protocol's evolving update shapes into a small, stable event
 * vocabulary. Keeping this pure makes ordering/status behavior testable without
 * spawning the Grok CLI.
 */
function normalizeAcpUpdate(update) {
  if (!update || typeof update !== "object") return { type: "unknown", rawKind: "", update };
  const rawKind = String(update.sessionUpdate || update.type || "");

  if (
    rawKind === "available_commands_update" ||
    rawKind === "availableCommands" ||
    Array.isArray(update.availableCommands)
  ) {
    return { type: "commands", rawKind, commands: update.availableCommands || [] };
  }
  if (rawKind === "current_mode_update" || rawKind === "mode_update") {
    return { type: "mode", rawKind, mode: update.currentModeId || update.modeId || update };
  }
  if (rawKind === "agent_message_chunk") {
    return {
      type: "assistant.chunk",
      rawKind,
      text: update.content?.text ?? update.text ?? "",
    };
  }
  if (rawKind === "agent_thought_chunk") {
    return {
      type: "thought.chunk",
      rawKind,
      text: update.content?.text ?? update.text ?? "",
    };
  }
  if (rawKind === "user_message_chunk") return { type: "user.chunk", rawKind };
  if (rawKind === "diff_review") {
    return {
      type: "tool.update",
      rawKind,
      tool: {
        toolCallId: update.toolCallId || `diff-review-${Date.now()}`,
        title: update.title || "Edit",
        kind: "edit",
        status: update.status || "completed",
        content: update.content ?? null,
      },
    };
  }
  if (rawKind === "tool_call") {
    return {
      type: "tool.start",
      rawKind,
      tool: {
        toolCallId: update.toolCallId,
        title: update.title || update.kind || "tool",
        kind: update.kind,
        status: update.status || "running",
        rawInput: update.rawInput ?? update.input ?? null,
        content: update.content ?? null,
      },
    };
  }
  if (rawKind === "tool_call_update") {
    const tool = {
      toolCallId: update.toolCallId,
      status: update.status || "updated",
    };
    if (update.title != null) tool.title = update.title;
    if (update.kind != null) tool.kind = update.kind;
    if (update.rawInput != null || update.input != null) {
      tool.rawInput = update.rawInput ?? update.input;
    }
    if (update.content != null) tool.content = update.content;
    if (update.rawOutput != null) tool.rawOutput = update.rawOutput;
    return { type: "tool.update", rawKind, tool };
  }
  if (rawKind === "plan") return { type: "plan", rawKind, plan: update };
  if (
    /^subagent/i.test(rawKind) ||
    rawKind === "task_backgrounded" ||
    rawKind === "task_completed" ||
    rawKind === "taskBackgrounded" ||
    rawKind === "taskCompleted"
  ) {
    return { type: "subagent", rawKind, update };
  }
  return { type: "unknown", rawKind, update };
}

function isHydrateSafeEvent(event) {
  return event?.type === "commands" || event?.type === "mode";
}

module.exports = {
  normalizeAcpUpdate,
  isHydrateSafeEvent,
};

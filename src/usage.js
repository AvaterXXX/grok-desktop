"use strict";

const fs = require("fs");

function shanghaiDate(d = new Date()) {
  return d
    .toLocaleString("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .slice(0, 10);
}

function formatResetZh(iso) {
  if (!iso) return "";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return String(iso);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dt);
  const get = (type, fallback = "") => parts.find((part) => part.type === type)?.value || fallback;
  return `${get("weekday")} ${get("month")}/${get("day")} ${get("hour", "00")}:${get("minute", "00")}`.trim();
}

function centVal(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object" && typeof value.val === "number") return value.val;
  return null;
}

function parseBillingPayload(data) {
  if (!data || typeof data !== "object") return null;
  const cfg = data.config && typeof data.config === "object" ? data.config : data;
  const percentRaw =
    cfg.creditUsagePercent ?? cfg.credit_usage_percent ?? cfg.percent ?? cfg.usagePercent;
  const used = centVal(cfg.used);
  const limit = centVal(cfg.monthlyLimit || cfg.monthly_limit || cfg.limit);
  let percent = typeof percentRaw === "number" ? percentRaw : null;
  if (percent == null && percentRaw != null && String(percentRaw).trim() !== "") {
    const n = Number(percentRaw);
    if (Number.isFinite(n)) percent = n;
  }
  if (percent == null && used != null && limit) percent = Math.round((used / limit) * 1000) / 10;
  const period = cfg.currentPeriod || cfg.current_period || {};
  const resetAt = period.end || cfg.billingPeriodEnd || cfg.billing_period_end || "";
  const periodStart =
    period.start || period.begin || cfg.billingPeriodStart || cfg.billing_period_start || "";
  if (percent == null && resetAt) percent = 0;
  if (percent == null && !resetAt) return null;
  const subscriptionTier = data.subscriptionTier || data.subscription_tier || "";
  return {
    percent,
    resetAt,
    periodStart,
    reset: formatResetZh(resetAt),
    subscriptionTier,
    raw: `周限额 ${percent ?? "—"}% · 刷新 ${formatResetZh(resetAt) || resetAt || "—"}`,
  };
}

function readLogTail(file, maxBytes = 2_000_000) {
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

function billingFromLog(text) {
  const lines = String(text || "").split(/\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !/billing:\s*fetched credits config|creditUsagePercent|currentPeriod/i.test(line))
      continue;
    try {
      const event = JSON.parse(line);
      for (const candidate of [event, event.ctx, event.context, event.data, event.config]) {
        if (candidate == null) continue;
        let value = candidate;
        if (typeof candidate === "string") {
          try {
            value = JSON.parse(candidate);
          } catch {
            continue;
          }
        }
        const parsed = parseBillingPayload(value);
        if (parsed) return parsed;
      }
    } catch {
      // Ignore truncated or unrelated JSONL entries.
    }
  }
  return null;
}

function pickToken(object, keys) {
  if (!object || typeof object !== "object") return 0;
  for (const key of keys) {
    const value = Number(object[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function tokenPartsOf(context, event) {
  const sources = [context, event, event?.usage, event?.tokenUsage, context?.usage].filter(Boolean);
  const get = (keys) => {
    for (const source of sources) {
      const value = pickToken(source, keys);
      if (value) return value;
    }
    return 0;
  };
  const input = get(["prompt_tokens", "promptTokens", "inputTokens", "input_tokens"]);
  const output = get(["completion_tokens", "completionTokens", "outputTokens", "output_tokens"]);
  const reasoning = get(["reasoning_tokens", "reasoningTokens"]);
  const cache = get([
    "cached_prompt_tokens",
    "cachedPromptTokens",
    "cache_read_tokens",
    "cacheReadTokens",
    "cached_tokens",
    "cachedTokens",
  ]);
  return { input, output, reasoning, cache, total: input + output + reasoning };
}

function emptyDaily() {
  return { tokens: 0, input: 0, output: 0, reasoning: 0, cache: 0, byModel: {} };
}

function modelFamilyOf(id) {
  const value = String(id || "");
  if (/4[.-]?5/.test(value)) return "grok-4.5";
  if (/4[.-]?6/.test(value)) return "grok-4.6";
  return value || "grok-4.6";
}

function addTokenParts(accumulator, parts) {
  accumulator.tokens = (Number(accumulator.tokens) || 0) + (Number(parts.total) || 0);
  accumulator.input = (Number(accumulator.input) || 0) + (Number(parts.input) || 0);
  accumulator.output = (Number(accumulator.output) || 0) + (Number(parts.output) || 0);
  accumulator.reasoning = (Number(accumulator.reasoning) || 0) + (Number(parts.reasoning) || 0);
  accumulator.cache = (Number(accumulator.cache) || 0) + (Number(parts.cache) || 0);
  return accumulator;
}

function addByModel(accumulator, family, parts) {
  if (!accumulator.byModel) accumulator.byModel = {};
  if (!accumulator.byModel[family]) {
    accumulator.byModel[family] = { tokens: 0, input: 0, output: 0, reasoning: 0, cache: 0 };
  }
  addTokenParts(accumulator.byModel[family], parts);
  return accumulator;
}

function mergeByModelMax(a, b) {
  const out = {};
  for (const source of [a || {}, b || {}]) {
    for (const [key, slot] of Object.entries(source)) {
      const current = out[key];
      if (!current || (Number(slot.tokens) || 0) > (Number(current.tokens) || 0))
        out[key] = { ...slot };
    }
  }
  return out;
}

function eventTimeMs(event) {
  const timestamp =
    event?.ts ||
    event?.time ||
    event?.timestamp ||
    event?.t ||
    event?.ctx?.ts ||
    event?.ctx?.time ||
    "";
  if (typeof timestamp === "number" && Number.isFinite(timestamp))
    return timestamp > 1e12 ? timestamp : timestamp * 1000;
  if (!timestamp) return 0;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function weekStartDate(billing) {
  if (billing?.periodStart) {
    const start = new Date(billing.periodStart);
    if (!Number.isNaN(start.getTime())) return start;
  }
  if (billing?.resetAt) {
    const end = new Date(billing.resetAt);
    if (!Number.isNaN(end.getTime())) return new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  }
  return null;
}

function isInferenceEvent(event, context) {
  const message = String(
    event?.msg || event?.message || event?.event || event?.name || event?.kind || "",
  );
  return (
    /inference_done|inference done/i.test(message) ||
    context?.prompt_tokens != null ||
    event?.prompt_tokens != null ||
    context?.promptTokens != null
  );
}

function addEventToDaily(accumulator, event) {
  const context = event.ctx || event.data || event;
  if (!isInferenceEvent(event, context)) return false;
  const parts = tokenPartsOf(context, event);
  if (!parts.total && !parts.cache) return false;
  addTokenParts(accumulator, parts);
  addByModel(
    accumulator,
    modelFamilyOf(
      context.model ||
        event.model ||
        event.modelId ||
        event.model_id ||
        context.modelId ||
        context.model_id,
    ),
    parts,
  );
  return true;
}

function usageSinceFromLog(text, sinceMs) {
  const accumulator = emptyDaily();
  const since = Number(sinceMs) || 0;
  if (!since) return accumulator;
  for (const line of String(text || "").split(/\n/)) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const time = eventTimeMs(event);
    if (!time || time < since) continue;
    addEventToDaily(accumulator, event);
  }
  return accumulator;
}

function dailyHistoryFromLog(text) {
  const days = {};
  for (const line of String(text || "").split(/\n/)) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const time = eventTimeMs(event);
    if (!time) continue;
    const day = shanghaiDate(new Date(time));
    if (!days[day]) days[day] = emptyDaily();
    if (!addEventToDaily(days[day], event) && !days[day].tokens && !days[day].cache)
      delete days[day];
  }
  return days;
}

function slimDay(slot) {
  const source = slot || {};
  return {
    tokens: Number(source.tokens) || 0,
    input: Number(source.input) || 0,
    output: Number(source.output) || 0,
    reasoning: Number(source.reasoning) || 0,
    cache: Number(source.cache) || 0,
  };
}

function mergeDayMax(a, b) {
  const x = slimDay(a);
  const y = slimDay(b);
  return {
    tokens: Math.max(x.tokens, y.tokens),
    input: Math.max(x.input, y.input),
    output: Math.max(x.output, y.output),
    reasoning: Math.max(x.reasoning, y.reasoning),
    cache: Math.max(x.cache, y.cache),
  };
}

function pruneHistory(map, keepDays = 400) {
  const out = {};
  const keys = Object.keys(map || {}).sort();
  const retained = keys.length > keepDays ? keys.slice(-keepDays) : keys;
  for (const key of retained) out[key] = slimDay(map[key]);
  return out;
}

module.exports = {
  addByModel,
  addTokenParts,
  billingFromLog,
  dailyHistoryFromLog,
  emptyDaily,
  formatResetZh,
  mergeByModelMax,
  mergeDayMax,
  modelFamilyOf,
  parseBillingPayload,
  pruneHistory,
  readLogTail,
  shanghaiDate,
  tokenPartsOf,
  usageSinceFromLog,
  weekStartDate,
};

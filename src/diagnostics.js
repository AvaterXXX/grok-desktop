const SENSITIVE_KEY_RE =
  /(?:auth|base64|body|content|cookie|credential|cwd|data|message|password|path|prompt|proxy|secret|text|token|url)/i;

function sanitizeDiagnosticValue(value, key = "", depth = 0) {
  if (SENSITIVE_KEY_RE.test(key) && key !== "sessionId") return "[redacted]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.replace(/[\r\n\t]+/g, " ").slice(0, 256);
  if (depth >= 3) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => sanitizeDiagnosticValue(item, key, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 64)) {
      out[childKey] = sanitizeDiagnosticValue(childValue, childKey, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 128);
}

class DiagnosticRing {
  constructor({ capacity = 600, now = () => Date.now() } = {}) {
    this.capacity = Math.max(50, Math.min(5000, Number(capacity) || 600));
    this.now = now;
    this.sequence = 0;
    this.items = [];
  }

  record(type, details = {}) {
    const event = {
      sequence: ++this.sequence,
      at: new Date(this.now()).toISOString(),
      type: String(type || "event")
        .replace(/[^A-Za-z0-9:._-]/g, "_")
        .slice(0, 96),
      details: sanitizeDiagnosticValue(details, "details"),
    };
    this.items.push(event);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
    return event;
  }

  snapshot() {
    return this.items.map((item) => ({ ...item, details: { ...(item.details || {}) } }));
  }

  clear() {
    this.items.length = 0;
  }
}

module.exports = {
  DiagnosticRing,
  sanitizeDiagnosticValue,
};

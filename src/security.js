const path = require("path");

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@:/+-]{0,511}$/;
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".avif",
]);

function assertPlainObject(value, label = "payload") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function boundedString(
  value,
  { label = "value", max = 4096, allowEmpty = true, trim = false, pattern = null } = {},
) {
  if (value == null) {
    if (allowEmpty) return "";
    throw new TypeError(`${label} is required`);
  }
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const text = trim ? value.trim() : value;
  if (!allowEmpty && !text) throw new TypeError(`${label} is required`);
  if (text.length > max) throw new RangeError(`${label} is too long`);
  if (text.includes("\0")) throw new TypeError(`${label} contains invalid characters`);
  if (pattern && text && !pattern.test(text)) throw new TypeError(`${label} has an invalid format`);
  return text;
}

function optionalSessionId(value, label = "sessionId") {
  if (value == null || value === "") return "";
  return boundedString(value, {
    label,
    max: 256,
    allowEmpty: false,
    trim: true,
    pattern: SESSION_ID_RE,
  });
}

function requiredSessionId(value, label = "sessionId") {
  const id = optionalSessionId(value, label);
  if (!id) throw new TypeError(`${label} is required`);
  return id;
}

function safeName(value, label = "name", { allowEmpty = false } = {}) {
  return boundedString(value, {
    label,
    max: 512,
    allowEmpty,
    trim: true,
    pattern: allowEmpty && !value ? null : SAFE_NAME_RE,
  });
}

function boundedInteger(value, { label = "value", min = 0, max = 10_000, fallback = min } = {}) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new RangeError(`${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function boundedStringArray(value, { label = "values", maxItems = 64, maxLength = 4096 } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > maxItems) throw new RangeError(`${label} has too many items`);
  return value.map((item, index) =>
    boundedString(item, {
      label: `${label}[${index}]`,
      max: maxLength,
      allowEmpty: true,
    }),
  );
}

function normalizeAbsolutePath(value, label = "path") {
  const raw = boundedString(value, {
    label,
    max: 32_767,
    allowEmpty: false,
  });
  if (!path.isAbsolute(raw)) throw new TypeError(`${label} must be absolute`);
  return path.resolve(raw);
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(root, target, { allowRoot = true } = {}) {
  if (!root || !target) return false;
  const base = comparablePath(root);
  const full = comparablePath(target);
  if (allowRoot && full === base) return true;
  return full.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`);
}

function assertPathInside(target, roots, label = "path", options) {
  const full = normalizeAbsolutePath(target, label);
  const allowedRoots = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  if (!allowedRoots.some((root) => isPathInside(root, full, options))) {
    throw new TypeError(`${label} is outside the allowed directories`);
  }
  return full;
}

function isSafeImagePath(value) {
  try {
    const full = normalizeAbsolutePath(value);
    return IMAGE_EXTENSIONS.has(path.extname(full).toLowerCase());
  } catch {
    return false;
  }
}

function safeExternalUrl(value) {
  const raw = boundedString(value, {
    label: "url",
    max: 4096,
    allowEmpty: false,
    trim: true,
  });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError("url is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("only http and https URLs are allowed");
  }
  if (parsed.username || parsed.password) throw new TypeError("credentialed URLs are not allowed");
  return parsed.href;
}

function isTrustedIpcSender(event, expectedWebContents) {
  if (!event?.sender || !expectedWebContents || expectedWebContents.isDestroyed?.()) return false;
  if (event.sender.id !== expectedWebContents.id) return false;
  const senderFrame = event.senderFrame;
  const mainFrame = expectedWebContents.mainFrame;
  if (senderFrame && mainFrame && senderFrame.routingId !== mainFrame.routingId) return false;
  return true;
}

function assertTrustedIpcSender(event, expectedWebContents) {
  if (!isTrustedIpcSender(event, expectedWebContents)) {
    throw new Error("Rejected IPC request from an untrusted renderer");
  }
}

function estimatePayloadSize(value, seen = new Set()) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length * 2;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (typeof value !== "object") return 0;
  if (seen.has(value)) throw new TypeError("IPC payload must not be circular");
  seen.add(value);
  let total = 0;
  if (Array.isArray(value)) {
    for (const item of value) total += estimatePayloadSize(item, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      total += key.length * 2 + estimatePayloadSize(item, seen);
    }
  }
  seen.delete(value);
  return total;
}

function validateOptionalObject(value, label) {
  if (value == null) return {};
  return assertPlainObject(value, label);
}

function validateObjectSessionId(payload, label = "payload") {
  const object = validateOptionalObject(payload, label);
  if (object.sessionId != null && object.sessionId !== "") optionalSessionId(object.sessionId);
  return object;
}

/**
 * Validate and normalize renderer-controlled arguments before an IPC handler
 * sees them. Keep this list explicit: adding a privileged channel without a
 * case below fails closed in tests/review instead of silently accepting data.
 */
function validateIpcRequest(channel, args = []) {
  if (!Array.isArray(args)) throw new TypeError("IPC arguments must be an array");
  const size = estimatePayloadSize(args);
  if (size > 64 * 1024 * 1024) throw new RangeError("IPC payload is too large");

  const first = args[0];
  switch (channel) {
    case "sessions:list": {
      const payload = validateOptionalObject(first);
      if (payload.limit != null)
        boundedInteger(payload.limit, { label: "limit", min: 1, max: 500 });
      break;
    }
    case "sessions:rename": {
      const payload = validateObjectSessionId(first);
      requiredSessionId(payload.sessionId);
      boundedString(payload.title, { label: "title", max: 300, allowEmpty: false, trim: true });
      break;
    }
    case "sessions:delete":
    case "sessions:history": {
      const payload = validateObjectSessionId(first);
      requiredSessionId(payload.sessionId);
      break;
    }
    case "sessions:path":
    case "sessions:usage":
    case "sessions:rewind":
    case "agents:close":
    case "session:activate":
    case "session:open":
    case "session:cancel":
    case "commands:list":
    case "session:export":
    case "models:list": {
      validateObjectSessionId(first);
      break;
    }
    case "sessions:searchContent": {
      const payload = validateOptionalObject(first);
      boundedString(payload.query || "", { label: "query", max: 512, trim: true });
      if (payload.limit != null)
        boundedInteger(payload.limit, { label: "limit", min: 1, max: 100 });
      break;
    }
    case "sessions:saveUi":
    case "sessions:saveGoal": {
      const payload = validateObjectSessionId(first);
      requiredSessionId(payload.sessionId);
      if (estimatePayloadSize(payload) > 512 * 1024)
        throw new RangeError("session sidecar is too large");
      break;
    }
    case "session:new": {
      const payload = validateOptionalObject(first);
      if (payload.cwd) normalizeAbsolutePath(payload.cwd, "cwd");
      break;
    }
    case "session:prompt": {
      const payload = validateObjectSessionId(first);
      boundedString(payload.text || "", { label: "text", max: 2 * 1024 * 1024 });
      const images = payload.images == null ? [] : payload.images;
      if (!Array.isArray(images) || images.length > 12)
        throw new RangeError("images must contain at most 12 items");
      for (const [index, image] of images.entries()) {
        const item = assertPlainObject(image, `images[${index}]`);
        const mime = boundedString(item.mimeType || "image/png", {
          label: `images[${index}].mimeType`,
          max: 64,
          allowEmpty: false,
        });
        if (!/^image\/(?:png|jpeg|gif|webp)$/i.test(mime))
          throw new TypeError("unsupported image type");
        boundedString(item.dataBase64 || "", {
          label: `images[${index}].dataBase64`,
          max: 5 * 1024 * 1024,
          allowEmpty: false,
        });
      }
      break;
    }
    case "file:describePaths":
      for (const [index, filePath] of boundedStringArray(first, {
        label: "paths",
        maxItems: 64,
        maxLength: 32_767,
      }).entries()) {
        normalizeAbsolutePath(filePath, `paths[${index}]`);
      }
      break;
    case "file:readImage":
      if (!isSafeImagePath(first)) throw new TypeError("file path is not a supported image");
      break;
    case "shell:openPath":
    case "shell:showItem":
    case "skills:open":
      normalizeAbsolutePath(first);
      break;
    case "shell:openExternal":
      args[0] = safeExternalUrl(first);
      break;
    case "permission:respond": {
      const payload = validateObjectSessionId(first);
      boundedString(payload.id, { label: "permission id", max: 256, allowEmpty: false });
      boundedString(payload.optionId, { label: "option id", max: 256, allowEmpty: false });
      break;
    }
    case "settings:saveDesktop":
    case "settings:saveGrok":
    case "account:usage":
    case "memory:listEntries":
    case "memory:upsertEntry":
    case "memory:append":
    case "memory:agentContext":
      validateOptionalObject(first);
      if (estimatePayloadSize(first) > 2 * 1024 * 1024)
        throw new RangeError("payload is too large");
      break;
    case "profile:setAvatar": {
      const payload = validateOptionalObject(first);
      const mime = boundedString(payload.mimeType || "image/png", { label: "mimeType", max: 64 });
      if (!/^image\/(?:png|jpeg|webp)$/i.test(mime)) throw new TypeError("unsupported avatar type");
      boundedString(payload.dataBase64 || "", { label: "dataBase64", max: 8 * 1024 * 1024 });
      break;
    }
    case "plugins:install":
      if (
        boundedString(first, {
          label: "plugin spec",
          max: 2048,
          allowEmpty: false,
          trim: true,
        }).startsWith("-")
      ) {
        throw new TypeError("plugin spec must not begin with an option");
      }
      break;
    case "plugins:uninstall":
    case "plugins:enable":
    case "plugins:disable":
    case "plugins:details":
    case "skills:read":
    case "mcp:remove":
      boundedString(first, { label: "name", max: 512, allowEmpty: false, trim: true });
      break;
    case "skills:create": {
      const payload = validateOptionalObject(first);
      boundedString(payload.name, { label: "name", max: 128, allowEmpty: false, trim: true });
      boundedString(payload.description || "", { label: "description", max: 8 * 1024 });
      break;
    }
    case "skills:write": {
      const payload = validateOptionalObject(first);
      boundedString(payload.name, { label: "name", max: 512, allowEmpty: false, trim: true });
      boundedString(payload.markdown || "", { label: "markdown", max: 2 * 1024 * 1024 });
      break;
    }
    case "memory:getEntry":
    case "memory:deleteEntry":
      boundedString(first, { label: "id", max: 256, allowEmpty: false });
      break;
    case "memory:read":
      normalizeAbsolutePath(first);
      break;
    case "memory:write": {
      const payload = validateOptionalObject(first);
      normalizeAbsolutePath(payload.path);
      boundedString(payload.content || "", { label: "content", max: 2 * 1024 * 1024 });
      break;
    }
    case "session:run-slash": {
      const payload = validateObjectSessionId(first);
      boundedString(payload.command, {
        label: "command",
        max: 128,
        allowEmpty: false,
        trim: true,
        pattern: /^\/?[A-Za-z0-9][A-Za-z0-9_-]*$/,
      });
      boundedString(payload.args || "", { label: "args", max: 64 * 1024 });
      break;
    }
    case "mcp:add": {
      const payload = validateOptionalObject(first);
      safeName(payload.name, "name");
      boundedString(payload.command, {
        label: "command",
        max: 32_767,
        allowEmpty: false,
        trim: true,
      });
      boundedStringArray(payload.args || [], { label: "args", maxItems: 128, maxLength: 8192 });
      break;
    }
    case "hooks:list": {
      const payload = validateOptionalObject(first);
      if (payload.cwd) normalizeAbsolutePath(payload.cwd, "cwd");
      break;
    }
    case "session:set-effort": {
      const payload = validateObjectSessionId(first);
      boundedString(payload.effort, {
        label: "effort",
        max: 16,
        allowEmpty: false,
        pattern: /^(?:low|medium|high|xhigh)$/,
      });
      break;
    }
    case "models:set":
      boundedString(first, { label: "modelId", max: 256, allowEmpty: false, trim: true });
      if (args[1]) optionalSessionId(args[1]);
      break;
    case "app:setBusyCount":
      boundedInteger(first, { label: "busy count", min: 0, max: 64 });
      break;
    case "app:notify": {
      const payload = validateObjectSessionId(first);
      boundedString(payload.title || "", { label: "title", max: 200 });
      boundedString(payload.body || "", { label: "body", max: 2000 });
      break;
    }
    default:
      // Channels with no renderer-controlled structured input are still
      // protected by the trusted-sender and overall payload-size checks.
      break;
  }
  return args;
}

module.exports = {
  IMAGE_EXTENSIONS,
  SESSION_ID_RE,
  assertPathInside,
  assertPlainObject,
  assertTrustedIpcSender,
  boundedInteger,
  boundedString,
  boundedStringArray,
  isPathInside,
  isSafeImagePath,
  isTrustedIpcSender,
  normalizeAbsolutePath,
  optionalSessionId,
  requiredSessionId,
  safeExternalUrl,
  safeName,
  validateIpcRequest,
};

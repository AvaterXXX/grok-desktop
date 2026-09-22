const fs = require("node:fs/promises");

const PREVIEW_LIMIT = 512 * 1024;

// The caller authorizes the path. Never execute or render file contents as HTML.
async function readFilePreview(full) {
  const handle = await fs.open(full, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { kind: "directory", size: stat.size };
    const buffer = Buffer.alloc(Math.min(stat.size, PREVIEW_LIMIT) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > PREVIEW_LIMIT;
    const data = buffer.subarray(0, Math.min(bytesRead, PREVIEW_LIMIT));
    let encoding = "utf-8";
    if (data[0] === 0xff && data[1] === 0xfe) encoding = "utf-16le";
    else if (data[0] === 0xfe && data[1] === 0xff) encoding = "utf-16be";
    else if (data.includes(0)) return { kind: "binary", size: stat.size };
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(data, { stream: truncated });
      return { kind: "text", text, size: stat.size, truncated };
    } catch {
      return { kind: "binary", size: stat.size };
    }
  } finally {
    await handle.close();
  }
}

module.exports = { readFilePreview, PREVIEW_LIMIT };

const fs = require("fs");
const path = require("path");

/**
 * Write a file through a same-directory temporary file and atomically replace
 * the destination. This prevents truncated JSON/TOML when the desktop process
 * is interrupted while persisting UI state.
 */
/**
 * @param {string} file
 * @param {string | NodeJS.ArrayBufferView} data
 * @param {fs.WriteFileOptions} [options]
 */
function atomicWriteFileSync(file, data, options = "utf8") {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  let fd = null;
  try {
    fd = fs.openSync(temp, "wx");
    fs.writeFileSync(fd, data, options);
    try {
      fs.fsyncSync(fd);
    } catch {
      // Some virtual/network filesystems do not support fsync. The atomic
      // rename still gives a safer result than writing the target in place.
    }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, target);
  } catch (error) {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* best effort cleanup */
    }
    throw error;
  }
}

function atomicWriteJsonSync(file, value, { pretty = false } = {}) {
  const spacing = pretty ? 2 : 0;
  atomicWriteFileSync(file, JSON.stringify(value, null, spacing), "utf8");
}

module.exports = {
  atomicWriteFileSync,
  atomicWriteJsonSync,
};

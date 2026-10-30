const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

module.exports = function prepareTestProfile(name) {
  try {
    if (!/^[a-z-]+$/.test(name)) throw new Error("Invalid test profile name");
    const root = path.resolve(__dirname, "../artifacts/electron-profiles");
    fs.mkdirSync(root, { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, `${name}-`));
    app.setPath("userData", directory);
    app.setPath("sessionData", directory);
    return directory;
  } catch (error) {
    // Fail in the test log, not Electron's uncaught-exception dialog.
    console.error(`Test profile initialization failed: ${error.message}`);
    app.exit(1);
    return null;
  }
};

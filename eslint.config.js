const eslint = require("@eslint/js");
const globals = require("globals");

const sharedRules = {
  ...eslint.configs.recommended.rules,
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-useless-assignment": "off",
  "no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      caughtErrors: "none",
      varsIgnorePattern: "^_",
    },
  ],
};

module.exports = [
  {
    ignores: ["node_modules/**", "release/**", "dist/**", "coverage/**", "renderer/vendor/**"],
  },
  {
    files: ["main.js", "preload.js", "src/**/*.js", "scripts/**/*.js", "tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
      sourceType: "commonjs",
    },
    rules: sharedRules,
  },
  {
    files: ["renderer/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        grokDesktop: "readonly",
        GrokI18n: "readonly",
        GrokSessionState: "readonly",
        GrokSidebarModel: "readonly",
        GrokToolPresentation: "readonly",
        marked: "readonly",
        module: "readonly",
        renderMarkdown: "readonly",
        t: "readonly",
      },
      sourceType: "script",
    },
    rules: sharedRules,
  },
];

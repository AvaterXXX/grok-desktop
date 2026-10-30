"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { formatQuotaReset } = require("../renderer/time-format");

const RESET_AT = "2026-10-23T10:50:05.246Z";

test("english quota reset uses an English weekday", () => {
  assert.equal(formatQuotaReset(RESET_AT, "en"), "Fri 10/23, 6:50 PM");
});

test("simplified quota reset keeps the Chinese weekday", () => {
  assert.equal(formatQuotaReset(RESET_AT, "zh"), "周五 10/23 18:50");
});

test("traditional quota reset uses a traditional weekday", () => {
  assert.equal(formatQuotaReset(RESET_AT, "zh-Hant"), "週五 10/23 18:50");
});

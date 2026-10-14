/**
 * Unit tests for the whole-number text-field validation used by the
 * tournament settings.
 *
 *   npm run test:units
 */

import assert from "node:assert/strict";
import test from "node:test";

import { intFieldError } from "../src/utils/intField.ts";

const err = (raw, min = 1, max = 300) => intFieldError(raw, min, max);

test("accepts whole numbers in range, with stray spaces and zeros", () => {
  for (const ok of ["1", "60", "300", " 12 ", "007", "\t5\n", "0300"]) {
    assert.equal(err(ok), null, JSON.stringify(ok));
  }
  assert.equal(err("0", 0, 10), null);
});

test("empty and whitespace-only are required", () => {
  for (const bad of ["", "   ", "\t\n"]) {
    assert.equal(err(bad), "Required.", JSON.stringify(bad));
  }
});

test("decimals of every shape are rejected as such", () => {
  for (const bad of ["1.5", "1,5", "10.", ".5", ",5", "3.0", "-1.5", "+2.5"]) {
    assert.match(err(bad), /Whole numbers only/, bad);
  }
});

test("negatives are refused when the minimum is not negative", () => {
  assert.equal(err("-3"), "Can't be negative.");
  assert.equal(err("-0", 0, 10), "Can't be negative.");
  assert.equal(err("-3", -5, 5), null);
  assert.equal(err("-9", -5, 5), "Must be at least -5.");
});

test("letters, symbols, exponents and embedded spaces are digits-only errors", () => {
  for (const bad of ["abc", "12a", "a12", "1e3", "1E3", "0x10", "1 2", "1_000", "NaN", "Infinity", "+5", "５", "١٢", "٣", "5%", "$5", "--5", "1-"]) {
    assert.equal(err(bad), "Digits only (0-9).", bad);
  }
});

test("range limits are reported with the limit", () => {
  assert.equal(err("0"), "Must be at least 1.");
  assert.equal(err("301"), "Must be at most 300.");
  assert.equal(err("1", 2, 300), "Must be at least 2.");
  assert.equal(err("5", 0, 4), "Must be at most 4.");
});

test("huge inputs never become NaN or lose precision", () => {
  assert.equal(err("9".repeat(40)), "Must be at most 300.");
  assert.equal(err("1" + "0".repeat(20), 0, 2_147_483_647), "Must be at most 2147483647.");
  assert.equal(err("2147483647", 0, 2_147_483_647), null);
  assert.equal(err("2147483648", 0, 2_147_483_647), "Must be at most 2147483647.");
  // Leading zeros do not count towards length.
  assert.equal(err("0".repeat(30) + "7"), null);
});

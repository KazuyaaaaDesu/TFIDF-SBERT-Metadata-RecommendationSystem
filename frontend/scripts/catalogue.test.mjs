/** Unit tests for the Repository's card-catalogue helpers. */

import assert from "node:assert/strict";
import test from "node:test";

import { SPINE_STEPS, accession, spineColor, subjectHash } from "../src/utils/catalogue.ts";

test("accession numbers are zero padded and never negative", () => {
  assert.equal(accession(412), "№ 0412");
  assert.equal(accession(7), "№ 0007");
  assert.equal(accession(123456), "№ 123456");
  assert.equal(accession(-3), "№ 0000");
});

test("the same subject always gets the same hash, whatever its case or spacing", () => {
  assert.equal(subjectHash("Computer Science"), subjectHash("  computer   science "));
  assert.notEqual(subjectHash("Biology"), subjectHash("Mathematics"));
});

test("no subject means no spine", () => {
  assert.equal(spineColor(null), null);
  assert.equal(spineColor(undefined), null);
  assert.equal(spineColor("   "), null);
});

test("a spine colour follows the theme tokens, not fixed colours", () => {
  const colour = spineColor("Biology");
  assert.match(colour, /^color-mix\(in srgb, rgb\(var\(--accent\)\) \d+%, rgb\(var\(--gray-700\)\)\)$/);
  assert.equal(colour, spineColor("biology"));
});

test("subjects spread over several steps, all within 0 to 100 percent", () => {
  const subjects = ["Biology", "Mathematics", "Physics", "Chemistry", "Business Administration", "Linear Algebra", "Law", "History", "Economics", "Art"];
  const steps = new Set(subjects.map((s) => Number(spineColor(s).match(/(\d+)%/)[1])));

  assert.ok(steps.size >= 3, `only ${steps.size} distinct spine steps`);
  for (const value of steps) assert.ok(value >= 0 && value <= 100);
  assert.ok(steps.size <= SPINE_STEPS);
});

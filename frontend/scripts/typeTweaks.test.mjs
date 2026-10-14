/** Unit tests for the developer panel's typography settings. */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_UI_CUSTOM, normalize, normalizeType, resolveFont } from "../src/utils/uiCustom.ts";

test("defaults leave the site's own fonts and sizes alone", () => {
  const t = normalize(null).type;

  assert.equal(t.body.id, null);
  assert.equal(t.scale, 1);
  assert.equal(resolveFont(t.heading), null);
});

test("unknown fonts and junk values fall back", () => {
  const t = normalizeType({ body: { id: "nope" }, scale: "big", tracking: NaN, lineHeight: 99 });

  assert.equal(t.body.id, null);
  assert.equal(t.scale, 1);
  assert.equal(t.tracking, 0);
  assert.equal(t.lineHeight, 2.2);
});

test("numbers are clamped to their ranges", () => {
  assert.equal(normalizeType({ scale: 9 }).scale, 1.4);
  assert.equal(normalizeType({ scale: 0.1 }).scale, 0.8);
  assert.equal(normalizeType({ tracking: -1 }).tracking, -0.03);
});

test("a custom font needs a name and is sanitised", () => {
  assert.equal(normalizeType({ body: { id: "custom", custom: "" } }).body.id, null);

  const slot = normalizeType({ body: { id: "custom", custom: 'Karla"; } body{display:none' } }).body;
  const font = resolveFont(slot);

  assert.ok(!/[";{}]/.test(slot.custom));
  assert.match(font.stack, /^"Karla/);
  assert.ok(!/[";{}]/.test(font.google));
});

test("a catalog font resolves to its stack and Google query", () => {
  const font = resolveFont(normalizeType({ heading: { id: "lora" } }).heading);

  assert.match(font.stack, /Lora/);
  assert.match(font.google, /^Lora/);
});

test("old saved settings without a type block still load", () => {
  const old = { skin: "wood", crt: true, live: { on: true } };

  assert.deepEqual(normalize(old).type, DEFAULT_UI_CUSTOM.type);
});

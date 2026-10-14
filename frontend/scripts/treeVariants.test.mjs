/**
 * Unit tests for the tree color variants.
 *
 *   npm run test:units
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ORIGINAL_VARIANT,
  TREE_VARIANTS,
  hslToRgb,
  resolveVariant,
  rgbToHsl,
  tintBark,
  tintFoliage,
  variantsFor,
} from "../src/utils/treeVariants.ts";

const SPECIES = ["crimson", "oak", "birch", "elm", "redwood", "beanstalk", "rosevine"];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test("every species has its original colors plus three more palettes", () => {
  for (const id of SPECIES) {
    const list = variantsFor(id);

    assert.equal(list.length, 4, id);
    assert.equal(list[0].id, "original");

    const ids = new Set(list.map((v) => v.id));
    const labels = new Set(list.map((v) => v.label));

    assert.equal(ids.size, 4, `${id} has duplicate ids`);
    assert.equal(labels.size, 4, `${id} has duplicate names`);
  }
});

test("the original palette changes nothing", () => {
  for (const c of [[10, 20, 30], [200, 120, 40], [255, 255, 255], [0, 0, 0]]) {
    assert.deepEqual(tintFoliage(ORIGINAL_VARIANT, c), c);
    assert.deepEqual(tintBark(ORIGINAL_VARIANT, c), c);
  }
});

test("color conversion round-trips", () => {
  for (const c of [[200, 40, 30], [30, 120, 60], [250, 220, 90], [128, 128, 128], [12, 12, 200]]) {
    const back = hslToRgb(...rgbToHsl(c));

    assert.ok(dist(back, c) <= 2, `${c} -> ${back}`);
  }
});

test("a hue turn moves the hue by that many degrees", () => {
  const green = [60, 160, 70];
  const [h0] = rgbToHsl(green);
  const turned = tintFoliage({ ...ORIGINAL_VARIANT, foliage: { hue: 90, sat: 1, light: 0 } }, green);
  const [h1] = rgbToHsl(turned);
  const diff = (((h1 - h0 - 90) % 360) + 540) % 360 - 180;

  assert.ok(Math.abs(diff) < 3, `hue moved by ${h1 - h0}`);
});

test("every variant visibly recolors the foliage of its species", () => {
  const leaves = {
    crimson: [[232, 71, 42], [255, 122, 77], [196, 42, 28]],
    oak: [[60, 150, 60], [100, 190, 80]],
    birch: [[240, 200, 60], [200, 170, 40]],
    elm: [[230, 180, 40], [200, 150, 30]],
    redwood: [[40, 130, 110], [60, 160, 130]],
    beanstalk: [[60, 170, 60], [180, 240, 100]],
    rosevine: [[216, 31, 91], [255, 143, 180]],
  };

  for (const id of SPECIES) {
    for (const variant of TREE_VARIANTS[id].slice(1)) {
      for (const c of leaves[id]) {
        const out = tintFoliage(variant, c);

        assert.ok(dist(out, c) > 40, `${id}/${variant.id}: ${c} barely moved (${out})`);
        assert.ok(out.every((v) => Number.isInteger(v) && v >= 0 && v <= 255));
      }
    }
  }
});

test("variants of one species look different from each other", () => {
  const sample = [[232, 71, 42], [60, 150, 60], [240, 200, 60]];

  for (const id of SPECIES) {
    const list = variantsFor(id);

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const apart = sample.some(
          (c) => dist(tintFoliage(list[i], c), tintFoliage(list[j], c)) > 30,
        );

        assert.ok(apart, `${id}: ${list[i].id} and ${list[j].id} are too alike`);
      }
    }
  }
});

test("washing bark keeps its lightness, so the shading survives", () => {
  const bark = [[40, 34, 30], [110, 100, 90], [200, 190, 180]];

  for (const id of SPECIES) {
    for (const variant of TREE_VARIANTS[id].slice(1)) {
      for (const c of bark) {
        const out = tintBark(variant, c);
        const dl = Math.abs(rgbToHsl(out)[2] - rgbToHsl(c)[2]);

        assert.ok(dl < 0.03, `${id}/${variant.id}: lightness moved ${dl}`);
      }
    }
  }
});

test("an unknown variant or species falls back to the original", () => {
  assert.equal(resolveVariant("oak", "nope").id, "original");
  assert.equal(resolveVariant("oak", null).id, "original");
  assert.equal(resolveVariant("ghost", "x").id, "original");
  assert.equal(resolveVariant("elm", "wisteria").id, "wisteria");
});

test("swatches show four colors, and the original matches the art", async () => {
  const { variantSwatch } = await import("../src/utils/treeVariants.ts");

  for (const id of SPECIES) {
    for (const variant of variantsFor(id)) {
      const sw = variantSwatch(id, variant);

      assert.equal(sw.length, 4);
      assert.ok(sw.every((c) => /^rgb\(\d+, \d+, \d+\)$/.test(c)));
    }
  }

  assert.equal(variantSwatch("oak", ORIGINAL_VARIANT)[1], "rgb(79, 168, 62)");
  assert.notEqual(
    variantSwatch("oak", variantsFor("oak")[1])[1],
    variantSwatch("oak", ORIGINAL_VARIANT)[1],
  );
});

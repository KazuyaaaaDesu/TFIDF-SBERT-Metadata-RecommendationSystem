/** Unit tests for the simulated Pro Pack grant.   npm run test:units */
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProPack,
  pickSeedPackSpecies,
  PRO_PACK_PRICE_USD,
} from "../src/utils/proPack.ts";

const catalog = ["crimson", "oak", "birch"];
const fresh = { tokens: 5, fertilizerHold: 2, proPurchased: false };

test("the pack credits the bundle once", () => {
  const first = applyProPack(fresh, ["crimson"], catalog);
  assert.equal(first.granted, true);
  assert.equal(first.wallet.tokens, 1005);
  assert.equal(first.wallet.fertilizerHold, 1002);
  assert.equal(first.wallet.proPurchased, true);
  assert.equal(first.seedSpecies, "oak");
});

test("buying again never double-grants", () => {
  const first = applyProPack(fresh, ["crimson"], catalog);
  const second = applyProPack(first.wallet, ["crimson", "oak"], catalog);
  assert.equal(second.granted, false);
  assert.deepEqual(second.wallet, first.wallet);
  assert.equal(second.seedSpecies, null);
});

test("the seed pack skips owned trees", () => {
  assert.equal(pickSeedPackSpecies(["crimson", "oak"], catalog), "birch");
  assert.equal(pickSeedPackSpecies(catalog, catalog), null);
});

test("the price is a fixed constant", () => {
  assert.equal(PRO_PACK_PRICE_USD, 4.99);
});

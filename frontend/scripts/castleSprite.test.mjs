/**
 * Unit tests for the castle sprites at the top of the Garden's climbs.
 *
 *   npm run test:units
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CASTLE_H, CASTLE_W, MAT, castleSprite, drawCastle } from "../src/utils/castleSprite.ts";

const KINDS = ["rose", "bean"];

test("each castle is built once and is the same every time", () => {
  for (const kind of KINDS) {
    const a = castleSprite(kind);

    assert.equal(a, castleSprite(kind));
    assert.equal(a.C.length, CASTLE_W * CASTLE_H * 3);
    assert.equal(a.M.length, CASTLE_W * CASTLE_H);
  }
});

test("the castles have stone, roofs, a door, glowing windows and gold", () => {
  for (const kind of KINDS) {
    const { M, glass } = castleSprite(kind);
    const has = (code) => M.some((m) => m === code);

    for (const code of [MAT.stone, MAT.roof, MAT.door, MAT.glow, MAT.gold]) assert.ok(has(code), `${kind} lacks material ${code}`);
    assert.ok(glass.length > 50, `${kind} has few glowing pixels`);
  }
});

test("the two castles look different, and the giant's stone is paler", () => {
  const rose = castleSprite("rose");
  const bean = castleSprite("bean");
  let apart = 0;
  let roseLight = 0;
  let beanLight = 0;
  let n = 0;

  for (let k = 0; k < CASTLE_W * CASTLE_H; k++) {
    if (rose.M[k] === MAT.stone && bean.M[k] === MAT.stone) {
      n++;
      roseLight += rose.C[k * 3] + rose.C[k * 3 + 1] + rose.C[k * 3 + 2];
      beanLight += bean.C[k * 3] + bean.C[k * 3 + 1] + bean.C[k * 3 + 2];
      if (rose.C[k * 3] !== bean.C[k * 3]) apart++;
    }
  }
  assert.ok(apart > n / 2);
  assert.ok(beanLight > roseLight, "the giant's castle should be paler");
  /* the sleeper's door is the smaller one */
  assert.ok(bean.door.w > rose.door.w && bean.door.h > rose.door.h);
});

test("the vines appear in order as the growth rises, and the sleeper's have thorns", () => {
  for (const kind of KINDS) {
    const c = castleSprite(kind);
    const at = (g) => {
      let n = 0;

      for (const cane of c.canes) for (const p of cane.pts) if (p.tb <= g) n++;

      return n;
    };

    assert.ok(at(0.1) < at(0.3) && at(0.3) < at(0.6) && at(0.6) <= at(1), kind);
    assert.ok(c.leaves.every((l, i, a) => i === 0 || a[i - 1].tb <= l.tb), "leaves are sorted by growth");
  }
  assert.ok(castleSprite("rose").canes.some((cane) => cane.th.length > 0));
  assert.ok(castleSprite("bean").canes.every((cane) => cane.th.length === 0));
});

test("drawing stays inside the sprite and never paints with a bad alpha", () => {
  for (const kind of KINDS) {
    const c = castleSprite(kind);
    const seen = [];
    const painter = {
      paint: (x, y, col, a) => {
        assert.ok(a >= 0 && a <= 1, `alpha ${a}`);
        assert.ok(col.every((v) => Number.isFinite(v)));
        seen.push([x, y]);
      },
      leafPixels: () => ({ dx: [0, 1], dy: [0, 0], shade: [1, 2] }),
    };

    drawCastle(c, painter, 10, 20, 1, 0.5, 3);
    assert.ok(seen.length > 3000);
    assert.ok(seen.every(([x, y]) => x >= 10 && x < 10 + CASTLE_W && y >= 20 && y < 20 + CASTLE_H));
  }
});

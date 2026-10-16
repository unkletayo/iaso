import assert from "node:assert/strict";
import { test } from "node:test";
import { countRange, sumRange } from "../src/range.js";

test("countRange includes both ends", () => {
  assert.equal(countRange(1, 5), 5);
});

test("sumRange of a single value is that value", () => {
  assert.equal(sumRange(0, 0), 0);
});

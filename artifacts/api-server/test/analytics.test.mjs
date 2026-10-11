import test from "node:test";
import assert from "node:assert/strict";
import { analyticsAccessStatus, csvCell, percentChange } from "../src/lib/analytics-core.mjs";

test("analytics authorization permits only authenticated internal IDs 1 and 2", () => {
  assert.equal(analyticsAccessStatus(null), 401);
  assert.equal(analyticsAccessStatus({ id: 1 }), 200);
  assert.equal(analyticsAccessStatus({ id: 2 }), 200);
  for (const id of [0, 3, 18, -1]) assert.equal(analyticsAccessStatus({ id }), 403);
});

test("period comparison handles zero baselines and rounds to one decimal", () => {
  assert.equal(percentChange(0, 0), 0);
  assert.equal(percentChange(1, 0), null);
  assert.equal(percentChange(10, 8), 25);
  assert.equal(percentChange(2, 3), -33.3);
});

test("CSV escapes formulas and quotes", () => {
  assert.equal(csvCell("=1+1"), `"'=1+1"`);
  assert.equal(csvCell(`Jan "Kowalski"`), `"Jan ""Kowalski"""`);
  assert.equal(csvCell(null), `""`);
});

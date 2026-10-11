import test from "node:test";
import assert from "node:assert/strict";
import { analyticsAccessStatus, csvCell, percentChange } from "../src/lib/analytics-core.mjs";

test("analytics authorization permits the master admin and only the named moderator", () => {
  assert.equal(analyticsAccessStatus(null), 401);
  assert.equal(analyticsAccessStatus({ id: 45, role: "master_admin", slug: "don_hudinni" }), 200);
  assert.equal(analyticsAccessStatus({ id: 82, role: "moderator", slug: "don_lisciasty" }), 200);
  assert.equal(analyticsAccessStatus({ id: 2, role: "moderator", slug: "don_lisciasty" }), 200, "the account is matched by identity, not by its database ID");
  for (const user of [
    { id: 1, role: "admin", slug: "inny-kreator" },
    { id: 2, role: "moderator", slug: "inny-moderator" },
    { id: 18, role: "admin", slug: "don_lisciasty" },
    { id: 19, role: "moderator", slug: "don_lisciasty-podobny" },
  ]) assert.equal(analyticsAccessStatus(user), 403);
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

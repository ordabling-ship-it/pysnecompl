import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canCancelReservation,
  canConfirmPickup,
  canRespondToReservation,
  generatePickupCode,
  hashPickupCode,
  haversineKm,
  matchesPickupCode,
  normalizeCoordinates,
  toPriceCents,
} from "../src/lib/marketplace-core.mjs";

test("coordinates are validated and customer request locations are rounded", () => {
  assert.deepEqual(normalizeCoordinates(52.22971, 21.01224, 2), { lat: 52.23, lng: 21.01 });
  assert.equal(normalizeCoordinates(91, 0), null);
  assert.equal(normalizeCoordinates(0, NaN), null);
});

test("distance calculation returns kilometers and handles identical points", () => {
  assert.equal(haversineKm(52.2297, 21.0122, 52.2297, 21.0122), 0);
  const km = haversineKm(52.2297, 21.0122, 52.4064, 16.9252);
  assert.ok(km !== null && km > 275 && km < 280);
  assert.equal(haversineKm(91, 0, 0, 0), null);
});

test("creator-set prices are converted to cents with bounds", () => {
  assert.equal(toPriceCents(0), 0);
  assert.equal(toPriceCents(19.99), 1999);
  assert.equal(toPriceCents(-1), null);
  assert.equal(toPriceCents(1_000_001), null);
});

test("pickup code is random format and only its hash is suitable for persistence", () => {
  const code = generatePickupCode();
  assert.match(code, /^\d{8}$/);
  const storedHash = hashPickupCode(code);
  assert.match(storedHash, /^[a-f0-9]{64}$/);
  assert.equal(matchesPickupCode(code, storedHash), true);
  assert.equal(matchesPickupCode(code === "00000000" ? "00000001" : "00000000", storedHash), false);
  assert.equal(matchesPickupCode(code, "invalid"), false);
});

test("reservation transitions prevent repeated actions and code reuse", () => {
  assert.equal(canRespondToReservation("requested", "accept"), true);
  assert.equal(canRespondToReservation("requested", "reject"), true);
  assert.equal(canRespondToReservation("accepted", "reject"), false);
  assert.equal(canCancelReservation("requested"), true);
  assert.equal(canCancelReservation("accepted"), true);
  assert.equal(canCancelReservation("picked_up"), false);
  assert.equal(canConfirmPickup("accepted", new Date(Date.now() + 60_000)), true);
  assert.equal(canConfirmPickup("picked_up", new Date(Date.now() + 60_000)), false);
  assert.equal(canConfirmPickup("accepted", new Date(Date.now() - 1)), false);
});

test("public marketplace routes are mounted before catch-all admin routers", async () => {
  const routes = await readFile(new URL("../src/routes/index.ts", import.meta.url), "utf8");
  assert.ok(routes.indexOf("router.use(marketplaceRouter)") < routes.indexOf("router.use(statsRouter)"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canCancelReservation,
  canConfirmPickup,
  canRespondToReservation,
  calculatePlatformFee,
  decryptPickupCode,
  encryptPickupCode,
  generatePickupCode,
  hashPickupCode,
  haversineKm,
  matchesPickupCode,
  normalizeCoordinates,
  toPriceCents,
} from "../src/lib/marketplace-core.mjs";

test("coordinates are validated and the rounding helper is deterministic", () => {
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
  assert.equal(canConfirmPickup("pickup_ready", new Date(Date.now() + 60_000)), true);
  assert.equal(canConfirmPickup("picked_up", new Date(Date.now() + 60_000)), false);
  assert.equal(canConfirmPickup("accepted", new Date(Date.now() - 1)), false);
});

test("marketplace fee is fixed 1.23 PLN plus 5 percent", () => {
  assert.deepEqual(calculatePlatformFee(3000), { grossAmountCents: 3000, platformFeeCents: 273, creatorNetCents: 2727 });
  assert.deepEqual(calculatePlatformFee(999), { grossAmountCents: 999, platformFeeCents: 173, creatorNetCents: 826 });
  assert.equal(calculatePlatformFee(-1), null);
});

test("pickup code can be encrypted for paid delivery and decrypted server-side", () => {
  const ciphertext = encryptPickupCode("12345678", "test-session-secret");
  assert.ok(ciphertext);
  assert.equal(decryptPickupCode(ciphertext, "test-session-secret"), "12345678");
  assert.equal(decryptPickupCode(ciphertext, "wrong-secret"), null);
});

test("public marketplace routes are mounted before catch-all admin routers", async () => {
  const routes = await readFile(new URL("../src/routes/index.ts", import.meta.url), "utf8");
  assert.ok(routes.indexOf("router.use(marketplaceRouter)") < routes.indexOf("router.use(statsRouter)"));
});

test("recipient requests use a fixed 500 m placement radius and idempotent proposal checkout", async () => {
  const routes = await readFile(new URL("../src/routes/marketplace.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../src/lib/prepare-database.ts", import.meta.url), "utf8");
  assert.match(routes, /RECIPIENT_PLACEMENT_RADIUS_KM = 0\.5/);
  assert.match(routes, /\/marketplace\/requests\/:requestId\/proposals\/:proposalId\/checkout/);
  assert.match(routes, /normalizeCoordinates\(lat, lng, 5\)/);
  assert.match(schema, /marketplace_reservations_proposal_unique/);
  assert.match(routes, /<= r\.radius_km/);
});

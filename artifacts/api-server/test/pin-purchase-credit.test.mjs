import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CREATOR_PIN_PACKAGES, FIRST_PURCHASE_BONUS_PINS, getCreatorPinPackage } from "../../../lib/api-zod/src/pin-packages.mjs";
import { creditPendingPurchaseOnce } from "../src/lib/pin-purchase-credit.mjs";

test("the four one-time packages have the agreed pins and Stripe amounts", () => {
  assert.deepEqual(CREATOR_PIN_PACKAGES.map(({ id, pins, amountCents }) => [id, pins, amountCents]), [
    ["start", 20, 9_900],
    ["growth", 50, 19_900],
    ["popular", 100, 29_900],
    ["event", 250, 59_900],
  ]);
  assert.equal(getCreatorPinPackage("unknown"), null);
  assert.equal(FIRST_PURCHASE_BONUS_PINS, 5);
});

test("the first paid purchase gets one bonus and duplicate delivery cannot credit twice", async () => {
  let balance = 10;
  let bonusGranted = false;
  let purchaseStatus = "pending";
  let savedBonus = 0;
  const callbacks = {
    purchaseId: 1,
    firstPurchaseBonusPins: FIRST_PURCHASE_BONUS_PINS,
    markPaidIfPending: async () => {
      if (purchaseStatus !== "pending") return null;
      purchaseStatus = "paid";
      return { id: 1, creatorUserId: 7, pins: 20 };
    },
    lockCreator: async () => ({ id: 7, firstPurchaseBonusGranted: bonusGranted }),
    addPins: async (_creatorId, pins) => { balance += pins; },
    markFirstPurchaseBonusGranted: async () => { bonusGranted = true; },
    saveBonusPins: async (_purchaseId, pins) => { savedBonus = pins; },
  };

  const firstDelivery = await creditPendingPurchaseOnce(callbacks);
  assert.deepEqual(firstDelivery, { creatorUserId: 7, pins: 20, bonusPins: 5, addedPins: 25 });
  assert.equal(balance, 35);
  assert.equal(savedBonus, 5);

  const duplicateDelivery = await creditPendingPurchaseOnce(callbacks);
  assert.equal(duplicateDelivery, null);
  assert.equal(balance, 35);
});

test("later purchases do not receive the first-purchase bonus", async () => {
  let balance = 35;
  let purchaseStatus = "pending";
  const result = await creditPendingPurchaseOnce({
    purchaseId: 2,
    firstPurchaseBonusPins: FIRST_PURCHASE_BONUS_PINS,
    markPaidIfPending: async () => {
      if (purchaseStatus !== "pending") return null;
      purchaseStatus = "paid";
      return { id: 2, creatorUserId: 7, pins: 50 };
    },
    lockCreator: async () => ({ id: 7, firstPurchaseBonusGranted: true }),
    addPins: async (_creatorId, pins) => { balance += pins; },
    markFirstPurchaseBonusGranted: async () => assert.fail("bonus already granted"),
    saveBonusPins: async (_purchaseId, pins) => assert.equal(pins, 0),
  });

  assert.deepEqual(result, { creatorUserId: 7, pins: 50, bonusPins: 0, addedPins: 50 });
  assert.equal(balance, 85);
});

test("public pricing page lists only the four one-time creator packages", async () => {
  const page = await readFile(new URL("../../treasure-hunt/public/cennik.html", import.meta.url), "utf8");
  const appScreen = await readFile(new URL("../../treasure-hunt/src/pages/AppScreen.tsx", import.meta.url), "utf8");
  const authScreen = await readFile(new URL("../../treasure-hunt/src/pages/AuthScreen.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../../treasure-hunt/src/App.tsx", import.meta.url), "utf8");
  const paymentRoute = await readFile(new URL("../src/routes/payments.ts", import.meta.url), "utf8");
  assert.ok(page.includes("<strong>20</strong><small>pinezek · pakiet Start</small>"));
  assert.ok(page.includes("<strong>50</strong><small>pinezek · pakiet Rozwój</small>"));
  assert.ok(page.includes("<strong>100</strong><small>pinezek · pakiet Popularny</small>"));
  assert.ok(page.includes("<strong>250</strong><small>pinezek · pakiet Event</small>"));
  for (const price of ["99 <span>zł</span>", "199 <span>zł</span>", "299 <span>zł</span>", "599 <span>zł</span>"]) {
    assert.ok(page.includes(price));
  }
  assert.equal((page.match(/<article class="pack(?: best| value)?">/g) ?? []).length, 4);
  assert.doesNotMatch(page, /abonament|miesięczn|miesieczn|cykliczn|25 pinezek/i);
  assert.match(page, /grid-template-columns:repeat\(4,1fr\)/);
  assert.match(page, /@media\(max-width:850px\)\{\.packs\{grid-template-columns:repeat\(2,1fr\)\}/);
  assert.match(page, /@media\(max-width:650px\)[\s\S]*?\.packs\{grid-template-columns:1fr/);
  assert.match(appScreen, /const isCreator = user\?\.role === "admin"/);
  assert.match(appScreen, /user && !layoutPreview && \(hasUnlimitedPins \|\| isCreator\)/, "only creators and unlimited-pin managers see their balance panel");
  assert.match(appScreen, /CREATOR_PIN_PACKAGES\.map/);
  assert.match(appScreen, /user\?\.id === 1 \|\| user\?\.id === 2/, "only the two authorized internal IDs see the analytics link");
  assert.doesNotMatch(appScreen, /BuyCoffee|buycoffee|pin-topups/);
  assert.match(app, /routeMode === "analytics" && user/);
  assert.match(app, /user\.id !== 1 && user\.id !== 2/);
  assert.match(paymentRoute, /router\.post\("\/payments\/checkout-session", requireRole\("admin"\)/);
  assert.match(paymentRoute, /mode: "payment"/);
  assert.match(paymentRoute, /session\.amount_total !== purchase\.amountCents/);
  assert.match(paymentRoute, /purchase\.pins !== expectedPackage\.pins/);
  assert.equal((authScreen.match(/href="\/cennik\.html"/g) ?? []).length, 0, "pricing is shown only after a creator has logged in");
});

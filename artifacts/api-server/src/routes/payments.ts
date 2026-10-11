import { Router, type IRouter, type Request, type Response } from "express";
import Stripe from "stripe";
import { and, eq, sql } from "drizzle-orm";
import { auditLogsTable, db, stripePinPurchasesTable, usersTable } from "@workspace/db";
import { FIRST_PURCHASE_BONUS_PINS, getCreatorPinPackage } from "@workspace/api-zod/pin-packages";
import { getAuthenticatedAdmin, requireRole, type AdminUser } from "../lib/admin-session";
import { recordAudit } from "../lib/audit";
import { creditPendingPurchaseOnce } from "../lib/pin-purchase-credit.mjs";

const router: IRouter = Router();

function getStripe(): Stripe | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  return secretKey ? new Stripe(secretKey) : null;
}

function publicAppUrl(): string | null {
  const configured = process.env.APP_BASE_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

router.post("/payments/checkout-session", requireRole("admin"), async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const user = res.locals.adminUser as AdminUser;

  const packageId = req.body?.packageId;
  const selectedPackage = getCreatorPinPackage(packageId);
  if (!selectedPackage) {
    res.status(400).json({ error: "Wybierz jeden z dostępnych pakietów pinezek." });
    return;
  }

  const stripe = getStripe();
  const appUrl = publicAppUrl();
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET || !appUrl) {
    res.status(503).json({ error: "Płatności online nie są jeszcze skonfigurowane." });
    return;
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: String(user.id),
      metadata: { creator_user_id: String(user.id), package_id: selectedPackage.id },
      payment_intent_data: { metadata: { creator_user_id: String(user.id), package_id: selectedPackage.id } },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "pln",
          unit_amount: selectedPackage.amountCents,
          product_data: {
            name: `${selectedPackage.pins} pinezek — pakiet ${selectedPackage.name}`,
            description: `Pula pinezek dla Kreatora ${user.name}.`,
          },
        },
      }],
      success_url: `${appUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/?payment=cancelled`,
    });

    if (!session.url) {
      res.status(502).json({ error: "Stripe nie zwrócił linku do płatności. Spróbuj ponownie." });
      return;
    }

    await db.insert(stripePinPurchasesTable).values({
      creatorUserId: user.id,
      stripeSessionId: session.id,
      packageId: selectedPackage.id,
      pins: selectedPackage.pins,
      amountCents: selectedPackage.amountCents,
      currency: "pln",
      status: "pending",
    });
    await recordAudit("pin_pack_payment_started", user.id, user.id, {
      packageId: selectedPackage.id,
      pins: selectedPackage.pins,
      amountCents: selectedPackage.amountCents,
      currency: "pln",
    });

    req.log.info({ creatorUserId: user.id, packageId: selectedPackage.id }, "Stripe Checkout session created");
    res.status(201).json({ url: session.url });
  } catch (error) {
    req.log.error({ error, creatorUserId: user.id }, "Stripe Checkout session could not be created");
    res.status(502).json({ error: "Nie udało się rozpocząć płatności. Spróbuj ponownie." });
  }
});

router.get("/payments/checkout-session/:sessionId", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const user = await getAuthenticatedAdmin(req);
  if (!user) {
    res.status(401).json({ error: "Zaloguj się ponownie, aby sprawdzić płatność." });
    return;
  }
  if (user.role !== "admin") {
    res.status(403).json({ error: "Brak dostępu do statusu płatności Kreatora." });
    return;
  }
  const sessionId = req.params.sessionId;
  if (!sessionId || sessionId.length > 255 || !sessionId.startsWith("cs_")) {
    res.status(400).json({ error: "Nieprawidłowy identyfikator płatności." });
    return;
  }

  const [purchase] = await db.select({ status: stripePinPurchasesTable.status, bonusPins: stripePinPurchasesTable.bonusPins })
    .from(stripePinPurchasesTable)
    .where(and(eq(stripePinPurchasesTable.stripeSessionId, sessionId), eq(stripePinPurchasesTable.creatorUserId, user.id)))
    .limit(1);
  if (!purchase) {
    res.status(404).json({ error: "Nie znaleziono tej płatności." });
    return;
  }

  const [freshUser] = await db.select({ pinBalance: usersTable.pinBalance, firstPurchaseBonusGranted: usersTable.firstPurchaseBonusGranted })
    .from(usersTable).where(eq(usersTable.id, user.id)).limit(1);
  res.json({
    status: purchase.status,
    pinBalance: freshUser?.pinBalance ?? user.pinBalance,
    bonusPins: purchase.bonusPins,
    firstPurchaseBonusGranted: freshUser?.firstPurchaseBonusGranted ?? false,
  });
});

export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.get("stripe-signature");
  if (!stripe || !webhookSecret || !signature || !Buffer.isBuffer(req.body)) {
    res.status(503).send("Stripe webhook is not configured.");
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch {
    res.status(400).send("Invalid Stripe signature.");
    return;
  }

  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
    if (paymentIntentId) {
      // Checkout's completion and refund webhooks can arrive in either order.
      // Resolve the Checkout session if its completion event has not stored the
      // PaymentIntent ID on the purchase yet.
      const [knownPurchase] = await db.select({ id: stripePinPurchasesTable.id })
        .from(stripePinPurchasesTable)
        .where(eq(stripePinPurchasesTable.stripePaymentIntentId, paymentIntentId))
        .limit(1);
      let fallbackSessionId: string | null = null;
      if (!knownPurchase) {
        const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
        fallbackSessionId = sessions.data[0]?.id ?? null;
      }
      const purchase = await db.transaction(async (tx) => {
        let [current] = await tx.select().from(stripePinPurchasesTable)
          .where(eq(stripePinPurchasesTable.stripePaymentIntentId, paymentIntentId)).limit(1).for("update");
        if (!current && fallbackSessionId) {
          [current] = await tx.select().from(stripePinPurchasesTable)
            .where(eq(stripePinPurchasesTable.stripeSessionId, fallbackSessionId)).limit(1).for("update");
        }
        if (!current || current.currency !== charge.currency || charge.amount_refunded <= current.refundAmountCents) return null;
        const deltaCents = charge.amount_refunded - current.refundAmountCents;
        await tx.update(stripePinPurchasesTable)
          .set({ refundAmountCents: charge.amount_refunded, stripePaymentIntentId: paymentIntentId })
          .where(eq(stripePinPurchasesTable.id, current.id));
        await tx.insert(auditLogsTable).values({
          eventType: "pin_pack_refunded",
          actorUserId: null,
          tenantUserId: current.creatorUserId,
          details: {
            refundedAmountCents: charge.amount_refunded,
            refundDeltaCents: deltaCents,
            purchaseAmountCents: current.amountCents,
            currency: current.currency,
            fullyRefunded: charge.amount_refunded >= current.amountCents,
            status: charge.amount_refunded >= current.amountCents ? "refunded" : "partially_refunded",
          },
        });
        return true;
      });
      if (!purchase && fallbackSessionId) req.log.warn({ sessionId: fallbackSessionId }, "Stripe refund did not match a stored pin purchase");
    }
    res.json({ received: true });
    return;
  }

  if (event.type === "checkout.session.async_payment_failed" || event.type === "checkout.session.expired") {
    const session = event.data.object as Stripe.Checkout.Session;
    const status = event.type === "checkout.session.expired" ? "expired" : "failed";
    const [updated] = await db.update(stripePinPurchasesTable)
      .set({ status })
      .where(and(eq(stripePinPurchasesTable.stripeSessionId, session.id), eq(stripePinPurchasesTable.status, "pending")))
      .returning({ creatorUserId: stripePinPurchasesTable.creatorUserId });
    if (updated) {
      await recordAudit(`pin_pack_payment_${status}`, null, updated.creatorUserId, { status });
    }
    res.json({ received: true });
    return;
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status !== "paid") {
      res.json({ received: true });
      return;
    }

    const [purchase] = await db.select().from(stripePinPurchasesTable)
      .where(eq(stripePinPurchasesTable.stripeSessionId, session.id)).limit(1);
    const metadataUserId = Number(session.metadata?.creator_user_id);
    const packageId = session.metadata?.package_id;
    const expectedPackage = getCreatorPinPackage(packageId);
    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
    if (!purchase) {
      // A webhook can beat the database insert that records the Checkout session.
      // Ask Stripe to retry instead of acknowledging an order that has not been stored yet.
      req.log.warn({ sessionId: session.id }, "Stripe payment arrived before its pin purchase was stored");
      res.status(500).send("Pin purchase is not available yet.");
      return;
    }
    if (!expectedPackage || session.mode !== "payment" ||
        purchase.creatorUserId !== metadataUserId || String(purchase.creatorUserId) !== session.client_reference_id ||
        purchase.packageId !== packageId || purchase.pins !== expectedPackage.pins ||
        purchase.amountCents !== expectedPackage.amountCents || session.amount_total !== purchase.amountCents ||
        session.currency?.toLowerCase() !== purchase.currency) {
      req.log.error({ sessionId: session.id }, "Stripe payment did not match a stored pin purchase");
      res.status(400).json({ error: "Stripe payment did not match the stored pin purchase." });
      return;
    }

    const credited = await db.transaction((tx) => creditPendingPurchaseOnce({
      purchaseId: purchase.id,
      firstPurchaseBonusPins: FIRST_PURCHASE_BONUS_PINS,
      markPaidIfPending: async (purchaseId) => {
        const [paidPurchase] = await tx.update(stripePinPurchasesTable)
          .set({ status: "paid", paidAt: new Date(), stripePaymentIntentId: paymentIntentId })
          .where(and(eq(stripePinPurchasesTable.id, purchaseId), eq(stripePinPurchasesTable.status, "pending")))
          .returning({ id: stripePinPurchasesTable.id, creatorUserId: stripePinPurchasesTable.creatorUserId, pins: stripePinPurchasesTable.pins });
        return paidPurchase ?? null;
      },
      lockCreator: async (creatorUserId) => {
        const [creator] = await tx.select({ id: usersTable.id, firstPurchaseBonusGranted: usersTable.firstPurchaseBonusGranted })
          .from(usersTable).where(eq(usersTable.id, creatorUserId)).limit(1).for("update");
        return creator ?? null;
      },
      addPins: async (creatorUserId, pins) => {
        await tx.update(usersTable)
          .set({ pinBalance: sql`${usersTable.pinBalance} + ${pins}` })
          .where(eq(usersTable.id, creatorUserId));
      },
      markFirstPurchaseBonusGranted: async (creatorUserId) => {
        await tx.update(usersTable).set({ firstPurchaseBonusGranted: true }).where(eq(usersTable.id, creatorUserId));
      },
      saveBonusPins: async (purchaseId, bonusPins) => {
        await tx.update(stripePinPurchasesTable).set({ bonusPins }).where(eq(stripePinPurchasesTable.id, purchaseId));
      },
    }));

    if (credited) {
      await recordAudit("pin_pack_purchased", null, credited.creatorUserId, {
        packageId: purchase.packageId,
        pins: credited.pins,
        bonusPins: credited.bonusPins,
        addedPins: credited.addedPins,
        amountCents: purchase.amountCents,
        currency: purchase.currency,
        status: "paid",
      });
      req.log.info({ creatorUserId: credited.creatorUserId, pins: credited.pins, bonusPins: credited.bonusPins }, "Stripe payment credited");
    }
  }

  res.json({ received: true });
}

export default router;

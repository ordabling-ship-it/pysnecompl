import { Router, type IRouter, type Request, type Response } from "express";
import Stripe from "stripe";
import { and, eq, sql } from "drizzle-orm";
import { db, stripePinPurchasesTable, usersTable } from "@workspace/db";
import { getAuthenticatedAdmin, requireRole, type AdminUser } from "../lib/admin-session";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

const PIN_PACKAGES = {
  small: { name: "Mały", pins: 50, amountCents: 24_900 },
  medium: { name: "Średni", pins: 100, amountCents: 44_900 },
  large: { name: "Duży", pins: 250, amountCents: 84_900 },
} as const;

type PinPackageId = keyof typeof PIN_PACKAGES;

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
  if (typeof packageId !== "string" || !Object.hasOwn(PIN_PACKAGES, packageId)) {
    res.status(400).json({ error: "Wybierz jeden z dostępnych pakietów pinezek." });
    return;
  }

  const stripe = getStripe();
  const appUrl = publicAppUrl();
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET || !appUrl) {
    res.status(503).json({ error: "Płatności online nie są jeszcze skonfigurowane." });
    return;
  }

  const selectedPackage = PIN_PACKAGES[packageId as PinPackageId];
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: String(user.id),
      metadata: { creator_user_id: String(user.id), package_id: packageId },
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
      packageId,
      pins: selectedPackage.pins,
      amountCents: selectedPackage.amountCents,
      currency: "pln",
    });

    req.log.info({ creatorUserId: user.id, packageId }, "Stripe Checkout session created");
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

  const [purchase] = await db.select({ status: stripePinPurchasesTable.status })
    .from(stripePinPurchasesTable)
    .where(and(eq(stripePinPurchasesTable.stripeSessionId, sessionId), eq(stripePinPurchasesTable.creatorUserId, user.id)))
    .limit(1);
  if (!purchase) {
    res.status(404).json({ error: "Nie znaleziono tej płatności." });
    return;
  }

  const [freshUser] = await db.select({ pinBalance: usersTable.pinBalance }).from(usersTable).where(eq(usersTable.id, user.id)).limit(1);
  res.json({ status: purchase.status, pinBalance: freshUser?.pinBalance ?? user.pinBalance });
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
    const expectedPackage = packageId && Object.hasOwn(PIN_PACKAGES, packageId) ? PIN_PACKAGES[packageId as PinPackageId] : null;
    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
    if (!purchase || !expectedPackage ||
        purchase.creatorUserId !== metadataUserId || String(purchase.creatorUserId) !== session.client_reference_id ||
        purchase.packageId !== packageId || purchase.pins !== expectedPackage.pins ||
        purchase.amountCents !== expectedPackage.amountCents || session.amount_total !== purchase.amountCents ||
        session.currency?.toLowerCase() !== purchase.currency) {
      req.log.error({ sessionId: session.id }, "Stripe payment did not match a stored pin purchase");
      res.json({ received: true });
      return;
    }

    const credited = await db.transaction(async (tx) => {
      const [paidPurchase] = await tx.update(stripePinPurchasesTable)
        .set({ status: "paid", paidAt: new Date(), stripePaymentIntentId: paymentIntentId })
        .where(and(eq(stripePinPurchasesTable.id, purchase.id), eq(stripePinPurchasesTable.status, "pending")))
        .returning({ creatorUserId: stripePinPurchasesTable.creatorUserId, pins: stripePinPurchasesTable.pins });
      if (!paidPurchase) return null;
      await tx.update(usersTable)
        .set({ pinBalance: sql`${usersTable.pinBalance} + ${paidPurchase.pins}` })
        .where(eq(usersTable.id, paidPurchase.creatorUserId));
      return paidPurchase;
    });

    if (credited) {
      await recordAudit("pin_pack_purchased", null, credited.creatorUserId, {
        packageId: purchase.packageId,
        pins: credited.pins,
        amountCents: purchase.amountCents,
        currency: purchase.currency,
      });
      req.log.info({ creatorUserId: credited.creatorUserId, pins: credited.pins }, "Stripe payment credited");
    }
  }

  res.json({ received: true });
}

export default router;

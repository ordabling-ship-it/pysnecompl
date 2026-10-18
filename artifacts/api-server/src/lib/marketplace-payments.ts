import Stripe from "stripe";
import { pool } from "@workspace/db";
import { calculatePlatformFee } from "./marketplace-core.mjs";
import { logger } from "./logger";

export function getStripe(): Stripe | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  return secretKey ? new Stripe(secretKey) : null;
}

export function publicAppUrl(): string | null {
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

export async function createCreatorOnboarding(userId: number, creatorName: string): Promise<{ url: string } | { error: string; status: number }> {
  const stripe = getStripe();
  const appUrl = publicAppUrl();
  if (!stripe || !appUrl) return { error: "Stripe Connect nie jest jeszcze skonfigurowany.", status: 503 };

  let account = (await pool.query("SELECT stripe_account_id FROM marketplace_stripe_accounts WHERE user_id = $1", [userId])).rows[0];
  if (!account) {
    const created = await stripe.accounts.create({
      type: "express",
      country: "PL",
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_profile: { name: creatorName.slice(0, 100) },
      metadata: { pysne_user_id: String(userId) },
    });
    await pool.query(
      `INSERT INTO marketplace_stripe_accounts (user_id, stripe_account_id, onboarding_status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (user_id) DO UPDATE SET stripe_account_id = EXCLUDED.stripe_account_id, updated_at = now()`,
      [userId, created.id],
    );
    account = { stripe_account_id: created.id };
  }

  const link = await stripe.accountLinks.create({
    account: account.stripe_account_id,
    type: "account_onboarding",
    refresh_url: `${appUrl}/marketplace/manage?connect=retry`,
    return_url: `${appUrl}/marketplace/manage?connect=return`,
  });
  return { url: link.url };
}

export async function refreshCreatorConnectStatus(userId: number): Promise<{ configured: boolean; accountId?: string; onboardingStatus?: string; chargesEnabled: boolean; payoutsEnabled: boolean; requirements?: unknown }> {
  const row = (await pool.query("SELECT * FROM marketplace_stripe_accounts WHERE user_id = $1", [userId])).rows[0];
  if (!row) return { configured: false, chargesEnabled: false, payoutsEnabled: false };
  const stripe = getStripe();
  if (!stripe) return { configured: true, accountId: row.stripe_account_id, onboardingStatus: row.onboarding_status, chargesEnabled: row.charges_enabled, payoutsEnabled: row.payouts_enabled, requirements: row.requirements };
  const account = await stripe.accounts.retrieve(row.stripe_account_id);
  const onboardingStatus = account.charges_enabled && account.payouts_enabled ? "ready" : "pending";
  await pool.query(
    `UPDATE marketplace_stripe_accounts SET onboarding_status = $2, charges_enabled = $3,
      payouts_enabled = $4, requirements = $5, updated_at = now() WHERE user_id = $1`,
    [userId, onboardingStatus, account.charges_enabled, account.payouts_enabled, JSON.stringify(account.requirements ?? {})],
  );
  return { configured: true, accountId: row.stripe_account_id, onboardingStatus, chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled, requirements: account.requirements };
}

export async function createMarketplaceCheckout(reservationId: number, guestHash: string): Promise<{ url: string; sessionId: string } | { error: string; status: number }> {
  const stripe = getStripe();
  const appUrl = publicAppUrl();
  if (!stripe || !appUrl) return { error: "Płatności marketplace nie są jeszcze skonfigurowane.", status: 503 };
  const row = (await pool.query(
    `SELECT r.id, r.status, r.payment_status, r.gross_amount_cents, r.stripe_checkout_session_id,
            r.creator_user_id, r.currency, a.stripe_account_id, a.charges_enabled, a.payouts_enabled
       FROM marketplace_reservations r LEFT JOIN marketplace_stripe_accounts a ON a.user_id = r.creator_user_id
      WHERE r.id = $1 AND r.guest_session_hash = $2`,
    [reservationId, guestHash],
  )).rows[0];
  if (!row) return { error: "Nie znaleziono rezerwacji.", status: 404 };
  if (row.status !== "accepted") return { error: "Płatność będzie dostępna po akceptacji rezerwacji przez Kreatora.", status: 409 };
  if (!row.charges_enabled || !row.payouts_enabled || !row.stripe_account_id) return { error: "Kreator nie ma jeszcze aktywnych wypłat Stripe.", status: 409 };
  if (row.stripe_checkout_session_id) {
    const existing = await stripe.checkout.sessions.retrieve(row.stripe_checkout_session_id);
    if (existing.status === "open" && existing.url) return { url: existing.url, sessionId: existing.id };
  }
  const fee = calculatePlatformFee(Number(row.gross_amount_cents));
  if (!fee || fee.grossAmountCents <= 0) return { error: "Oferta bezpłatna nie wymaga Checkout.", status: 400 };
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    client_reference_id: `marketplace:${reservationId}`,
    metadata: { marketplace_reservation_id: String(reservationId), creator_user_id: String(row.creator_user_id) },
    payment_intent_data: { metadata: { marketplace_reservation_id: String(reservationId), creator_user_id: String(row.creator_user_id) } },
    line_items: [{ quantity: 1, price_data: { currency: "pln", unit_amount: fee.grossAmountCents, product_data: { name: "Rezerwacja skarbu w Pysne.com.pl" } } }],
    success_url: `${appUrl}/oferty?marketplace_payment=success&reservation_id=${reservationId}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/oferty?marketplace_payment=cancelled&reservation_id=${reservationId}`,
  });
  await pool.query(
    `UPDATE marketplace_reservations SET stripe_checkout_session_id = $2, payment_status = 'pending',
      gross_amount_cents = $3, platform_fee_cents = $4, creator_net_cents = $5, updated_at = now()
     WHERE id = $1 AND guest_session_hash = $6 AND status = 'accepted'`,
    [reservationId, session.id, fee.grossAmountCents, fee.platformFeeCents, fee.creatorNetCents, guestHash],
  );
  return { url: session.url!, sessionId: session.id };
}

async function claimEvent(event: Stripe.Event, reservationId: number | null): Promise<boolean> {
  const claimed = await pool.query(
    `INSERT INTO marketplace_stripe_events (event_id, event_type, reservation_id) VALUES ($1, $2, $3)
     ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [event.id, event.type, reservationId],
  );
  return Boolean(claimed.rows[0]);
}

export async function transferMarketplaceAfterPickup(reservationId: number): Promise<{ transferred: boolean; pending?: boolean; error?: string }> {
  const stripe = getStripe();
  if (!stripe) return { transferred: false, pending: true, error: "Stripe nie jest skonfigurowany." };
  const row = (await pool.query(
    `SELECT r.id, r.creator_net_cents, r.stripe_payment_intent_id, r.stripe_transfer_id,
            r.payment_status, a.stripe_account_id, a.payouts_enabled
       FROM marketplace_reservations r JOIN marketplace_stripe_accounts a ON a.user_id = r.creator_user_id
      WHERE r.id = $1`, [reservationId],
  )).rows[0];
  if (!row || row.payment_status === "not_required") return { transferred: true };
  if (row.payment_status !== "paid") return { transferred: Boolean(row?.stripe_transfer_id), pending: true };
  if (row.stripe_transfer_id) return { transferred: true };
  if (Number(row.creator_net_cents) <= 0) {
    await pool.query("UPDATE marketplace_reservations SET transferred_at = now(), payment_status = 'transferred', updated_at = now() WHERE id = $1 AND stripe_transfer_id IS NULL", [reservationId]);
    return { transferred: true };
  }
  if (!row.payouts_enabled || !row.stripe_account_id || !row.stripe_payment_intent_id) return { transferred: false, pending: true, error: "Konto Kreatora nie jest gotowe do wypłaty." };
  try {
    const transfer = await stripe.transfers.create({ amount: Number(row.creator_net_cents), currency: "pln", destination: row.stripe_account_id, metadata: { marketplace_reservation_id: String(reservationId) } }, { idempotencyKey: `pysne-marketplace-transfer-${reservationId}` });
    await pool.query("UPDATE marketplace_reservations SET stripe_transfer_id = $2, transferred_at = now(), payment_status = 'transferred', updated_at = now() WHERE id = $1 AND stripe_transfer_id IS NULL", [reservationId, transfer.id]);
    return { transferred: true };
  } catch (error) {
    return { transferred: false, pending: true, error: error instanceof Error ? error.message : "Transfer nie został wykonany." };
  }
}

export async function refundMarketplacePayment(reservationId: number): Promise<{ requested: boolean; error?: string }> {
  const stripe = getStripe();
  if (!stripe) return { requested: false, error: "Stripe nie jest skonfigurowany." };
  const row = (await pool.query("SELECT stripe_payment_intent_id, payment_status FROM marketplace_reservations WHERE id = $1", [reservationId])).rows[0];
  if (!row || row.payment_status !== "paid" || !row.stripe_payment_intent_id) return { requested: true };
  try {
    await stripe.refunds.create({ payment_intent: row.stripe_payment_intent_id, metadata: { marketplace_reservation_id: String(reservationId) } }, { idempotencyKey: `pysne-marketplace-refund-${reservationId}` });
    await pool.query("UPDATE marketplace_reservations SET payment_status = 'refund_pending', updated_at = now() WHERE id = $1", [reservationId]);
    return { requested: true };
  } catch (error) {
    return { requested: false, error: error instanceof Error ? error.message : "Zwrot nie został rozpoczęty." };
  }
}

async function reverseMarketplaceTransfer(reservationId: number, transferId: string | null): Promise<void> {
  const stripe = getStripe();
  if (!stripe || !transferId) return;
  try {
    await stripe.transfers.createReversal(
      transferId,
      { metadata: { marketplace_reservation_id: String(reservationId) } },
      { idempotencyKey: `pysne-marketplace-reversal-${reservationId}` },
    );
  } catch (error) {
    // The refund/dispute remains recorded even if the reversal must be retried
    // from the Stripe dashboard or a later webhook delivery.
    logger.error({ reservationId, error }, "Marketplace transfer reversal could not be created");
  }
}

export async function handleMarketplaceStripeEvent(event: Stripe.Event): Promise<boolean> {
  const object = event.data.object as Stripe.Checkout.Session | Stripe.PaymentIntent | Stripe.Charge | Stripe.Dispute;
  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    await pool.query(
      `UPDATE marketplace_stripe_accounts SET onboarding_status = $2, charges_enabled = $3,
        payouts_enabled = $4, requirements = $5, updated_at = now() WHERE stripe_account_id = $1`,
      [account.id, account.charges_enabled && account.payouts_enabled ? "ready" : "pending", account.charges_enabled, account.payouts_enabled, JSON.stringify(account.requirements ?? {})],
    );
    return true;
  }
  const metadata = "metadata" in object ? object.metadata : undefined;
  let reservationId = Number(metadata?.marketplace_reservation_id);
  if ((!Number.isSafeInteger(reservationId) || reservationId < 1) && (event.type === "charge.refunded" || event.type === "charge.dispute.created")) {
    const paymentIntentId = "payment_intent" in object
      ? (typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent?.id)
      : null;
    if (paymentIntentId) {
      reservationId = Number((await pool.query("SELECT id FROM marketplace_reservations WHERE stripe_payment_intent_id = $1", [paymentIntentId])).rows[0]?.id);
    }
  }
  if (!Number.isSafeInteger(reservationId) || reservationId < 1) return false;
  const markEvent = () => claimEvent(event, reservationId);

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = object as Stripe.Checkout.Session;
    if (session.payment_status !== "paid") { await markEvent(); return true; }
    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
    await pool.query(
      `UPDATE marketplace_reservations SET status = 'pickup_ready', payment_status = 'paid',
        stripe_payment_intent_id = $2, paid_at = now(), updated_at = now()
       WHERE id = $1 AND stripe_checkout_session_id = $3 AND status = 'accepted'`,
      [reservationId, paymentIntentId, session.id],
    );
    await markEvent();
    return true;
  }
  if (event.type === "checkout.session.expired") {
    const expired = await pool.query(
      "UPDATE marketplace_reservations SET payment_status = 'failed', status = 'expired', updated_at = now() WHERE id = $1 AND status = 'accepted' RETURNING offer_id",
      [reservationId],
    );
    if (expired.rows[0]) {
      await pool.query(
        "UPDATE marketplace_offers SET quantity_available = LEAST(quantity_total, quantity_available + 1), updated_at = now() WHERE id = $1",
        [expired.rows[0].offer_id],
      );
    }
    await markEvent();
    return true;
  }
  if (event.type === "checkout.session.async_payment_failed" || event.type === "payment_intent.payment_failed") {
    await pool.query("UPDATE marketplace_reservations SET payment_status = 'failed', updated_at = now() WHERE id = $1 AND status = 'accepted'", [reservationId]);
    await markEvent();
    return true;
  }
  if (event.type === "charge.dispute.created") {
    const disputed = await pool.query("UPDATE marketplace_reservations SET payment_status = 'disputed', status = 'disputed', disputed_at = now(), updated_at = now() WHERE id = $1 RETURNING stripe_transfer_id", [reservationId]);
    await reverseMarketplaceTransfer(reservationId, disputed.rows[0]?.stripe_transfer_id ?? null);
    await markEvent();
    return true;
  }
  if (event.type === "charge.refunded") {
    const refunded = await pool.query(
      "WITH prior AS (SELECT id, status, offer_id, stripe_transfer_id FROM marketplace_reservations WHERE id = $1 AND status IN ('paid', 'pickup_ready', 'disputed', 'expired', 'picked_up')) UPDATE marketplace_reservations r SET payment_status = 'refunded', status = 'refunded', refunded_at = now(), updated_at = now() FROM prior WHERE r.id = prior.id RETURNING prior.offer_id, prior.status AS previous_status, prior.stripe_transfer_id",
      [reservationId],
    );
    // A cancellation releases inventory before requesting the refund. In that
    // case the later Stripe refund webhook must update payment state without
    // releasing the same inventory a second time.
    if (refunded.rows[0] && ["paid", "pickup_ready", "disputed"].includes(refunded.rows[0].previous_status)) {
      await pool.query("UPDATE marketplace_offers SET quantity_available = LEAST(quantity_total, quantity_available + 1), updated_at = now() WHERE id = $1", [refunded.rows[0].offer_id]);
    }
    if (refunded.rows[0]?.stripe_transfer_id) {
      await reverseMarketplaceTransfer(reservationId, refunded.rows[0].stripe_transfer_id);
    } else if (!refunded.rows[0]) {
      await pool.query(
        "UPDATE marketplace_reservations SET payment_status = 'refunded', refunded_at = now(), updated_at = now() WHERE id = $1 AND status = 'cancelled'",
        [reservationId],
      );
    }
    await markEvent();
    return true;
  }
  return true;
}

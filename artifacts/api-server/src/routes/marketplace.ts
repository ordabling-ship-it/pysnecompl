import { Router, type IRouter, type Request, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { pool } from "@workspace/db";
import { requireRole, type AdminUser } from "../lib/admin-session";
import { logger } from "../lib/logger";
import { canCancelReservation, canConfirmPickup, canRespondToReservation, decryptPickupCode, encryptPickupCode, generatePickupCode, hashPickupCode, matchesPickupCode, normalizeCoordinates, toPriceCents } from "../lib/marketplace-core.mjs";
import { createCreatorOnboarding, createMarketplaceCheckout, refreshCreatorConnectStatus, refundMarketplacePayment, transferMarketplaceAfterPickup } from "../lib/marketplace-payments";

const router: IRouter = Router();
const GUEST_COOKIE = "pysne_market_guest";
const GUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESPONSE_WINDOW_HOURS = 24;
const PICKUP_WINDOW_DAYS = 7;
const requestLimits = new Map<string, { count: number; until: number }>();

type Coordinates = { lat: number; lng: number };

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function getGuestHash(req: Request, res: Response, create = false): string | null {
  let token = req.cookies?.[GUEST_COOKIE];
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
    if (!create) return null;
    token = randomBytes(32).toString("base64url");
    res.cookie(GUEST_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: GUEST_TTL_MS,
    });
  }
  return hash(token);
}

function validCoordinates(lat: unknown, lng: unknown): lat is number {
  return normalizeCoordinates(lat, lng) !== null;
}

function distanceKmSql(lat: string, lng: string, latParam: number, lngParam: number): string {
  return `(
    6371 * acos(least(1, greatest(-1,
      sin(radians(${lat})) * sin(radians($${latParam})) +
      cos(radians(${lat})) * cos(radians($${latParam})) *
      cos(radians(${lng}) - radians($${lngParam}))
    )))
  )`;
}

function distanceBetweenSql(latA: string, lngA: string, latB: string, lngB: string): string {
  return `(
    6371 * acos(least(1, greatest(-1,
      sin(radians(${latA})) * sin(radians(${latB})) +
      cos(radians(${latA})) * cos(radians(${latB})) *
      cos(radians(${lngA}) - radians(${lngB}))
    )))
  )`;
}

function requestAllowed(req: Request, bucket: string, max = 12): boolean {
  const now = Date.now();
  const key = `${bucket}:${req.ip ?? "unknown"}`;
  const current = requestLimits.get(key);
  if (!current || current.until <= now) {
    if (requestLimits.size > 3000) {
      for (const [savedKey, limit] of requestLimits) if (limit.until <= now) requestLimits.delete(savedKey);
    }
    requestLimits.set(key, { count: 1, until: now + 60_000 });
    return true;
  }
  current.count += 1;
  return current.count <= max;
}

function sameOrigin(req: Request): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const origin = req.get("origin");
  const host = req.get("host");
  return Boolean(origin && host && origin === `${req.protocol}://${host}`);
}

function publicWriteGuard(req: Request, res: Response): boolean {
  if (!sameOrigin(req)) {
    res.status(403).json({ error: "Żądanie pochodzi z niedozwolonego źródła." });
    return false;
  }
  if (!req.is("application/json")) {
    res.status(415).json({ error: "Żądanie musi zawierać dane JSON." });
    return false;
  }
  return true;
}

async function releaseExpired(client: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> } & { __paidExpiredReservationIds?: number[] }): Promise<void> {
  const expired = await client.query(
    `UPDATE marketplace_reservations SET status = 'expired', pickup_code_hash = '', pickup_code_ciphertext = NULL,
        payment_status = CASE WHEN payment_status = 'paid' THEN 'refund_pending' ELSE 'failed' END,
        updated_at = now()
      WHERE (status = 'requested' AND response_deadline <= now())
         OR (status IN ('accepted', 'pickup_ready') AND pickup_expires_at <= now())
      RETURNING id, offer_id, creator_user_id, guest_session_hash, payment_status`,
  );
  for (const row of expired.rows) {
    if (row.payment_status === "refund_pending") {
      client.__paidExpiredReservationIds ??= [];
      client.__paidExpiredReservationIds.push(Number(row.id));
    } else {
      await client.query(
        "UPDATE marketplace_offers SET quantity_available = LEAST(quantity_total, quantity_available + 1), updated_at = now() WHERE id = $1",
        [row.offer_id],
      );
    }
    await client.query(
      `INSERT INTO marketplace_events (actor_user_id, guest_session_hash, offer_id, reservation_id, event_type)
       VALUES (NULL, $1, $2, $3, 'reservation_expired')`,
      [row.guest_session_hash, row.offer_id, row.id],
    );
  }
}

async function withTransaction<T>(work: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    for (const reservationId of (client as any).__paidExpiredReservationIds ?? []) {
      const refund = await refundMarketplacePayment(reservationId);
      if (!refund.requested) logger.error({ reservationId, error: refund.error }, "Expired marketplace payment refund could not be started");
    }
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function parseOfferId(value: string | string[]): number | null {
  const id = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

router.get("/marketplace/connect/status", requireRole("admin"), async (_req, res): Promise<void> => {
  const creator = res.locals.adminUser as AdminUser;
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await refreshCreatorConnectStatus(creator.id));
  } catch (error) {
    logger.error({ error, userId: creator.id }, "Stripe Connect status could not be refreshed");
    res.status(503).json({ error: "Nie udało się sprawdzić konfiguracji wypłat." });
  }
});

router.post("/marketplace/connect/onboarding", requireRole("admin"), async (_req, res): Promise<void> => {
  const creator = res.locals.adminUser as AdminUser;
  try {
    const result = await createCreatorOnboarding(creator.id, creator.name);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    res.json(result);
  } catch (error) {
    logger.error({ error, userId: creator.id }, "Stripe Connect onboarding could not be created");
    res.status(502).json({ error: "Nie udało się rozpocząć konfiguracji wypłat." });
  }
});

// Public discovery. Search location is supplied by the visitor, and is not
// stored. Only offers intentionally published by a Creator are returned.
router.get("/marketplace/offers", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  if (!requestAllowed(req, "offer-search", 60)) { res.status(429).json({ error: "Za dużo wyszukiwań. Spróbuj ponownie za minutę." }); return; }
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = Number(req.query.radiusKm ?? 10);
  if (!validCoordinates(lat, lng) || !Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 50) {
    res.status(400).json({ error: "Wskaż prawidłową lokalizację i promień od 1 do 50 km." });
    return;
  }

  const guestHash = getGuestHash(req, res, true);
  const distance = distanceKmSql("m.lat", "m.lng", 1, 2);
  const latitudeDelta = radiusKm / 111.32;
  const longitudeDelta = Math.min(180, radiusKm / (111.32 * Math.max(0.01, Math.cos((lat * Math.PI) / 180))));
  const south = Math.max(-90, lat - latitudeDelta);
  const north = Math.min(90, lat + latitudeDelta);
  const west = lng - longitudeDelta;
  const east = lng + longitudeDelta;
  let longitudeBounds = "m.lng BETWEEN $6 AND $7";
  let westBound = Math.max(-180, west);
  let eastBound = Math.min(180, east);
  if (west < -180) { longitudeBounds = "(m.lng >= $6 OR m.lng <= $7)"; westBound = west + 360; eastBound = east; }
  if (east > 180) { longitudeBounds = "(m.lng >= $6 OR m.lng <= $7)"; westBound = west; eastBound = east - 360; }
  const result = await pool.query(
    `SELECT o.id, u.name AS "creatorName", m.title, m.description, m.category,
            m.image_url AS "imageUrl", m.lat, m.lng, o.price_cents AS "priceCents",
            o.currency, o.quantity_available AS "availableQuantity", o.pickup_details AS "pickupDetails",
            o.pickup_until AS "pickupUntil", ${distance} AS "distanceKm",
            COALESCE(rep.positive, 0)::int AS "creatorPositive", COALESCE(rep.negative, 0)::int AS "creatorNegative",
            (COALESCE(rep.positive, 0) + COALESCE(rep.negative, 0))::int AS "creatorRatingCount",
            CASE WHEN (COALESCE(rep.positive, 0) + COALESCE(rep.negative, 0)) >= 25 AND rep.positive * 100 >= (rep.positive + rep.negative) * 95 THEN 'Bardzo wiarygodny'
                 WHEN (COALESCE(rep.positive, 0) + COALESCE(rep.negative, 0)) >= 10 AND rep.positive * 100 >= (rep.positive + rep.negative) * 90 THEN 'Zaufany'
                 WHEN (COALESCE(rep.positive, 0) + COALESCE(rep.negative, 0)) >= 5 AND rep.positive * 100 >= (rep.positive + rep.negative) * 80 THEN 'Sprawdzony' ELSE 'Nowy Kreator' END AS "creatorBadge"
       FROM marketplace_offers o
       JOIN markers m ON m.id = o.marker_id AND m.archived_at IS NULL
       JOIN users u ON u.id = o.creator_user_id
       LEFT JOIN (SELECT creator_user_id, count(*) FILTER (WHERE vote = 1) AS positive,
                         count(*) FILTER (WHERE vote = -1) AS negative FROM marketplace_ratings GROUP BY creator_user_id) rep
         ON rep.creator_user_id = o.creator_user_id
      WHERE o.status = 'active' AND o.quantity_available > 0
        AND (o.pickup_until IS NULL OR o.pickup_until > now())
        AND m.lat BETWEEN $4 AND $5 AND ${longitudeBounds}
        AND ${distance} <= $3
      ORDER BY ${distance}, o.created_at DESC
      LIMIT 100`,
    [lat, lng, radiusKm, south, north, westBound, eastBound],
  );

  if (guestHash && result.rows.length) {
    for (const offer of result.rows) {
      await pool.query(
        `INSERT INTO marketplace_events (guest_session_hash, offer_id, event_type)
         VALUES ($1, $2, 'offer_view') ON CONFLICT DO NOTHING`,
        [guestHash, offer.id],
      );
    }
  }
  res.json(result.rows.map((offer) => ({ ...offer, distanceKm: Number(offer.distanceKm) })));
});

router.get("/marketplace/offers/:offerId", async (req, res): Promise<void> => {
  if (!requestAllowed(req, "offer-detail", 60)) { res.status(429).json({ error: "Za dużo żądań. Spróbuj ponownie za minutę." }); return; }
  const offerId = parseOfferId(req.params.offerId);
  if (!offerId) { res.status(400).json({ error: "Nieprawidłowa oferta." }); return; }
  const guestHash = getGuestHash(req, res, true);
  const result = await pool.query(
    `SELECT o.id, u.name AS "creatorName", m.title,
            m.description, m.category, m.image_url AS "imageUrl", m.lat, m.lng,
            o.price_cents AS "priceCents", o.currency, o.quantity_available AS "availableQuantity",
            o.pickup_details AS "pickupDetails", o.pickup_until AS "pickupUntil",
            COALESCE(rep.positive, 0)::int AS "creatorPositive", COALESCE(rep.negative, 0)::int AS "creatorNegative",
            (COALESCE(rep.positive, 0) + COALESCE(rep.negative, 0))::int AS "creatorRatingCount",
            CASE WHEN (COALESCE(rep.positive, 0) + COALESCE(rep.negative, 0)) >= 25 AND rep.positive * 100 >= (rep.positive + rep.negative) * 95 THEN 'Bardzo wiarygodny'
                 WHEN (COALESCE(rep.positive, 0) + COALESCE(rep.negative, 0)) >= 10 AND rep.positive * 100 >= (rep.positive + rep.negative) * 90 THEN 'Zaufany'
                 WHEN (COALESCE(rep.positive, 0) + COALESCE(rep.negative, 0)) >= 5 AND rep.positive * 100 >= (rep.positive + rep.negative) * 80 THEN 'Sprawdzony' ELSE 'Nowy Kreator' END AS "creatorBadge"
       FROM marketplace_offers o JOIN markers m ON m.id = o.marker_id
       JOIN users u ON u.id = o.creator_user_id
       LEFT JOIN (SELECT creator_user_id, count(*) FILTER (WHERE vote = 1) AS positive,
                         count(*) FILTER (WHERE vote = -1) AS negative FROM marketplace_ratings GROUP BY creator_user_id) rep
         ON rep.creator_user_id = o.creator_user_id
      WHERE o.id = $1 AND o.status = 'active' AND o.quantity_available > 0 AND m.archived_at IS NULL LIMIT 1`,
    [offerId],
  );
  const offer = result.rows[0];
  if (!offer) { res.status(404).json({ error: "Ta oferta jest niedostępna." }); return; }
  if (guestHash) {
    await pool.query(
      `INSERT INTO marketplace_events (guest_session_hash, offer_id, event_type)
       VALUES ($1, $2, 'offer_view') ON CONFLICT DO NOTHING`,
      [guestHash, offerId],
    );
  }
  res.json(offer);
});

// Creator publishes or edits an offer attached to one of their existing pins.
router.post("/marketplace/offers", requireRole("admin"), async (req, res): Promise<void> => {
  const creator = res.locals.adminUser as AdminUser;
  const markerId = Number(req.body?.markerId);
  const pricePln = Number(req.body?.pricePln);
  const quantity = Number(req.body?.quantity);
  const pickupDetails = typeof req.body?.pickupDetails === "string" ? req.body.pickupDetails.trim() : "";
  const pickupUntil = req.body?.pickupUntil ? new Date(req.body.pickupUntil) : null;
  if (!Number.isSafeInteger(markerId) || markerId < 1 || !Number.isFinite(pricePln) || pricePln < 0 || pricePln > 1_000_000 ||
      !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000 || pickupDetails.length < 5 || pickupDetails.length > 1000 ||
      (pickupUntil && (!Number.isFinite(pickupUntil.getTime()) || pickupUntil <= new Date()))) {
    res.status(400).json({ error: "Sprawdź pinezkę, cenę, liczbę sztuk i informacje o odbiorze." });
    return;
  }
  const priceCents = toPriceCents(pricePln)!;
  const saved = await withTransaction(async (client) => {
    const marker = await client.query(
      "SELECT id FROM markers WHERE id = $1 AND owner_user_id = $2 AND archived_at IS NULL FOR UPDATE",
      [markerId, creator.id],
    );
    if (!marker.rows[0]) return { error: "Nie znaleziono własnej, aktywnej pinezki." };
    const existing = await client.query("SELECT * FROM marketplace_offers WHERE marker_id = $1 FOR UPDATE", [markerId]);
    if (existing.rows[0]) {
      const held = Number(existing.rows[0].quantity_total) - Number(existing.rows[0].quantity_available);
      if (quantity < held) return { error: `Nie można ustawić mniej niż ${held} szt. — tyle jest już zarezerwowanych.` };
      const updated = await client.query(
        `UPDATE marketplace_offers SET price_cents = $2, quantity_total = $3,
           quantity_available = $3::integer - $4::integer, pickup_details = $5, pickup_until = $6,
           status = 'active', updated_at = now()
         WHERE marker_id = $1 RETURNING id`,
        [markerId, priceCents, quantity, held, pickupDetails, pickupUntil],
      );
      return { id: updated.rows[0].id };
    }
    const inserted = await client.query(
      `INSERT INTO marketplace_offers (marker_id, creator_user_id, price_cents, quantity_total, quantity_available, pickup_details, pickup_until)
       VALUES ($1, $2, $3, $4, $4, $5, $6) RETURNING id`,
      [markerId, creator.id, priceCents, quantity, pickupDetails, pickupUntil],
    );
    return { id: inserted.rows[0].id };
  });
  if ("error" in saved) { res.status(400).json({ error: saved.error }); return; }
  res.status(201).json({ id: saved.id });
});

router.patch("/marketplace/offers/:offerId/status", requireRole("admin"), async (req, res): Promise<void> => {
  const creator = res.locals.adminUser as AdminUser;
  const offerId = parseOfferId(req.params.offerId);
  const status = req.body?.status;
  if (!offerId || (status !== "active" && status !== "paused")) {
    res.status(400).json({ error: "Nieprawidłowy status oferty." }); return;
  }
  const updated = await pool.query(
    "UPDATE marketplace_offers SET status = $3, updated_at = now() WHERE id = $1 AND creator_user_id = $2 RETURNING id",
    [offerId, creator.id, status],
  );
  if (!updated.rows[0]) { res.status(404).json({ error: "Nie znaleziono Twojej oferty." }); return; }
  res.json({ ok: true });
});

router.get("/marketplace/mine/offers", requireRole("admin"), async (_req, res): Promise<void> => {
  const creator = res.locals.adminUser as AdminUser;
  const result = await pool.query(
    `SELECT o.id, o.marker_id AS "markerId", m.title, m.category, m.lat, m.lng,
            o.price_cents AS "priceCents", o.quantity_total AS "quantityTotal",
            o.quantity_available AS "quantityAvailable", o.pickup_details AS "pickupDetails",
            o.pickup_until AS "pickupUntil", o.status
       FROM marketplace_offers o JOIN markers m ON m.id = o.marker_id
      WHERE o.creator_user_id = $1 AND m.archived_at IS NULL ORDER BY o.updated_at DESC`,
    [creator.id],
  );
  res.json(result.rows);
});

router.get("/marketplace/mine/reservations", requireRole("admin"), async (_req, res): Promise<void> => {
  const creator = res.locals.adminUser as AdminUser;
  const result = await withTransaction(async (client) => {
    await releaseExpired(client);
    return client.query(
      `SELECT r.id, r.offer_id AS "offerId", r.status, r.payment_status AS "paymentStatus",
              r.price_cents AS "priceCents", r.gross_amount_cents AS "grossAmountCents",
              r.platform_fee_cents AS "platformFeeCents", r.creator_net_cents AS "creatorNetCents",
              r.currency, r.response_deadline AS "responseDeadline", r.pickup_expires_at AS "pickupExpiresAt",
              r.requested_at AS "requestedAt", r.accepted_at AS "acceptedAt",
              m.title AS "offerTitle", r.guest_session_hash IS NOT NULL AS "guestPresent"
         FROM marketplace_reservations r JOIN marketplace_offers o ON o.id = r.offer_id
         JOIN markers m ON m.id = o.marker_id
        WHERE r.creator_user_id = $1 ORDER BY r.requested_at DESC LIMIT 200`,
      [creator.id],
    );
  });
  res.json(result.rows);
});

router.post("/marketplace/reservations", async (req, res): Promise<void> => {
  if (!publicWriteGuard(req, res)) return;
  if (!requestAllowed(req, "reservation", 8)) { res.status(429).json({ error: "Za dużo prób. Spróbuj ponownie za minutę." }); return; }
  const offerId = Number(req.body?.offerId);
  if (!Number.isSafeInteger(offerId) || offerId < 1) { res.status(400).json({ error: "Nieprawidłowa oferta." }); return; }
  const guestHash = getGuestHash(req, res, true)!;
  const pickupCode = generatePickupCode();
  const pickupCodeHash = hashPickupCode(pickupCode);
  const pickupCodeCiphertext = encryptPickupCode(pickupCode, process.env.SESSION_SECRET ?? "");
  if (!pickupCodeCiphertext) { res.status(503).json({ error: "Bezpieczne kody odbioru nie są jeszcze skonfigurowane." }); return; }
  const outcome = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [guestHash]);
    await releaseExpired(client);
    const recent = await client.query(
      "SELECT count(*)::int AS count FROM marketplace_reservations WHERE guest_session_hash = $1 AND requested_at > now() - interval '15 minutes'",
      [guestHash],
    );
    if (Number(recent.rows[0]?.count) >= 5) return { error: "Osiągnięto limit rezerwacji. Spróbuj ponownie później.", status: 429 };
    const updated = await client.query(
      `UPDATE marketplace_offers SET quantity_available = quantity_available - 1, updated_at = now()
        WHERE id = $1 AND status = 'active' AND quantity_available > 0
          AND (pickup_until IS NULL OR pickup_until > now())
        RETURNING id, creator_user_id, price_cents, currency`,
      [offerId],
    );
    const offer = updated.rows[0];
    if (!offer) return { error: "Oferta jest niedostępna lub wyczerpana.", status: 409 };
    const inserted = await client.query(
      `INSERT INTO marketplace_reservations (offer_id, creator_user_id, guest_session_hash, price_cents, currency, pickup_code_hash, pickup_code_ciphertext, response_deadline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8::integer * interval '1 hour'))
       RETURNING id, status, price_cents AS "priceCents", response_deadline AS "responseDeadline"`,
      [offer.id, offer.creator_user_id, guestHash, offer.price_cents, offer.currency, pickupCodeHash, pickupCodeCiphertext, RESPONSE_WINDOW_HOURS],
    );
    const reservation = inserted.rows[0];
    await client.query(
      `INSERT INTO marketplace_events (guest_session_hash, offer_id, reservation_id, event_type)
       VALUES ($1, $2, $3, 'reservation_requested')`,
      [guestHash, offer.id, reservation.id],
    );
    return { reservation };
  });
  if ("error" in outcome) { res.status(outcome.status ?? 400).json({ error: outcome.error }); return; }
  // The code is encrypted for later delivery after payment. It is never
  // returned before the Creator accepts and Stripe confirms the payment.
  res.status(201).json({ ...outcome.reservation, message: "Rezerwacja została wysłana. Kod odbioru pojawi się po akceptacji i płatności." });
});

router.get("/marketplace/mine/reservations/guest", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const guestHash = getGuestHash(req, res, false);
  if (!guestHash) { res.json([]); return; }
  const result = await withTransaction(async (client) => {
    await releaseExpired(client);
    return client.query(
      `SELECT r.id, r.status, r.payment_status AS "paymentStatus", r.price_cents AS "priceCents", r.currency,
              r.gross_amount_cents AS "grossAmountCents", r.platform_fee_cents AS "platformFeeCents",
              r.creator_net_cents AS "creatorNetCents", r.stripe_checkout_session_id AS "checkoutSessionId",
              r.pickup_code_ciphertext AS "pickupCodeCiphertext",
              r.response_deadline AS "responseDeadline", r.pickup_expires_at AS "pickupExpiresAt",
              r.requested_at AS "requestedAt", m.title AS "offerTitle", o.pickup_details AS "pickupDetails"
         FROM marketplace_reservations r JOIN marketplace_offers o ON o.id = r.offer_id
         JOIN markers m ON m.id = o.marker_id
        WHERE r.guest_session_hash = $1 ORDER BY r.requested_at DESC LIMIT 50`,
      [guestHash],
    );
  });
  res.json(result.rows.map((row: any) => ({
    ...row,
    pickupCode: row.status === "pickup_ready" || row.status === "paid"
      ? decryptPickupCode(row.pickupCodeCiphertext, process.env.SESSION_SECRET ?? "")
      : null,
    pickupCodeCiphertext: undefined,
  })));
});

router.post("/marketplace/reservations/:reservationId/cancel", async (req, res): Promise<void> => {
  if (!publicWriteGuard(req, res)) return;
  const guestHash = getGuestHash(req, res, false);
  const reservationId = parseOfferId(req.params.reservationId);
  if (!guestHash || !reservationId) { res.status(404).json({ error: "Nie znaleziono aktywnej rezerwacji." }); return; }
  const result = await withTransaction(async (client) => {
    await releaseExpired(client);
    const current = await client.query("SELECT status, payment_status FROM marketplace_reservations WHERE id = $1 AND guest_session_hash = $2 FOR UPDATE", [reservationId, guestHash]);
    if (!current.rows[0] || !canCancelReservation(current.rows[0].status)) return false;
    const cancelled = await client.query(
      `UPDATE marketplace_reservations SET status = 'cancelled', pickup_code_hash = '', pickup_code_ciphertext = NULL,
        updated_at = now() WHERE id = $1 AND guest_session_hash = $2 AND status IN ('requested', 'accepted', 'pickup_ready')
        RETURNING offer_id, payment_status`,
      [reservationId, guestHash],
    );
    if (!cancelled.rows[0]) return false;
    await client.query("UPDATE marketplace_offers SET quantity_available = LEAST(quantity_total, quantity_available + 1), updated_at = now() WHERE id = $1", [cancelled.rows[0].offer_id]);
    await client.query(
      `INSERT INTO marketplace_events (guest_session_hash, offer_id, reservation_id, event_type)
       VALUES ($1, $2, $3, 'reservation_cancelled')`,
      [guestHash, cancelled.rows[0].offer_id, reservationId],
    );
    return { offerId: cancelled.rows[0].offer_id, paymentStatus: cancelled.rows[0].payment_status };
  });
  if (!result) { res.status(409).json({ error: "Tej rezerwacji nie można już anulować." }); return; }
  const refund = result.paymentStatus === "paid" ? await refundMarketplacePayment(reservationId) : { requested: true };
  if (!refund.requested) { res.status(502).json({ error: "Rezerwacja anulowana, ale zwrot wymaga ponowienia." }); return; }
  res.json({ ok: true, refundStatus: result.paymentStatus === "paid" ? "pending" : "not_required" });
});

router.post("/marketplace/reservations/:reservationId/respond", requireRole("admin"), async (req, res): Promise<void> => {
  const creator = res.locals.adminUser as AdminUser;
  const reservationId = parseOfferId(req.params.reservationId);
  const action = req.body?.action;
  if (!reservationId || (action !== "accept" && action !== "reject")) { res.status(400).json({ error: "Wybierz przyjęcie albo odrzucenie rezerwacji." }); return; }
  if (action === "accept") {
    const reservationPrice = (await pool.query("SELECT price_cents FROM marketplace_reservations WHERE id = $1 AND creator_user_id = $2", [reservationId, creator.id])).rows[0];
    const account = (await pool.query("SELECT charges_enabled, payouts_enabled FROM marketplace_stripe_accounts WHERE user_id = $1", [creator.id])).rows[0];
    if (Number(reservationPrice?.price_cents) > 0 && (!account?.charges_enabled || !account?.payouts_enabled)) {
      res.status(409).json({ error: "Najpierw skonfiguruj aktywne konto Stripe Connect do przyjmowania wypłat." });
      return;
    }
  }
  const result = await withTransaction(async (client) => {
    await releaseExpired(client);
    const reservation = await client.query(
      "SELECT id, offer_id, status, price_cents, guest_session_hash, response_deadline FROM marketplace_reservations WHERE id = $1 AND creator_user_id = $2 FOR UPDATE",
      [reservationId, creator.id],
    );
    const row = reservation.rows[0];
    if (!row || !canRespondToReservation(row.status, action) || new Date(row.response_deadline) <= new Date()) return null;
    const nextStatus = action === "accept" ? (Number(row.price_cents) === 0 ? "pickup_ready" : "accepted") : "rejected";
    const changed = await client.query(
      `UPDATE marketplace_reservations SET status = CASE WHEN $2 = 'accepted' AND price_cents = 0 THEN 'pickup_ready' ELSE $2 END,
         payment_status = CASE WHEN $2 = 'accepted' AND price_cents = 0 THEN 'not_required' WHEN $2 = 'accepted' THEN 'pending' ELSE payment_status END,
         accepted_at = CASE WHEN $2 IN ('accepted', 'pickup_ready') THEN now() ELSE accepted_at END,
         pickup_expires_at = CASE WHEN $2 IN ('accepted', 'pickup_ready') THEN now() + ($3::integer * interval '1 day') ELSE NULL END,
         pickup_code_hash = CASE WHEN $2 = 'rejected' THEN '' ELSE pickup_code_hash END, updated_at = now()
       WHERE id = $1 AND status = 'requested' AND response_deadline > now() RETURNING id`,
      [reservationId, nextStatus, PICKUP_WINDOW_DAYS],
    );
    if (!changed.rows[0]) return null;
    if (action === "reject") {
      await client.query("UPDATE marketplace_offers SET quantity_available = LEAST(quantity_total, quantity_available + 1), updated_at = now() WHERE id = $1", [row.offer_id]);
    }
    await client.query(
      `INSERT INTO marketplace_events (actor_user_id, guest_session_hash, offer_id, reservation_id, event_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [creator.id, row.guest_session_hash, row.offer_id, reservationId, action === "accept" ? "reservation_accepted" : "reservation_rejected"],
    );
    return { status: nextStatus };
  });
  if (!result) { res.status(409).json({ error: "Rezerwacja wygasła albo została już obsłużona." }); return; }
  res.json(result);
});

router.post("/marketplace/reservations/:reservationId/checkout", async (req, res): Promise<void> => {
  if (!publicWriteGuard(req, res)) return;
  const guestHash = getGuestHash(req, res, false);
  const reservationId = parseOfferId(req.params.reservationId);
  if (!guestHash || !reservationId) { res.status(404).json({ error: "Nie znaleziono rezerwacji." }); return; }
  try {
    const result = await createMarketplaceCheckout(reservationId, guestHash);
    if ("error" in result) { res.status(result.status).json({ error: result.error }); return; }
    res.json(result);
  } catch (error) {
    logger.error({ error, reservationId }, "Marketplace Checkout could not be created");
    res.status(502).json({ error: "Nie udało się rozpocząć płatności." });
  }
});

router.post("/marketplace/reservations/:reservationId/pickup", requireRole("admin"), async (req, res): Promise<void> => {
  const creator = res.locals.adminUser as AdminUser;
  const reservationId = parseOfferId(req.params.reservationId);
  if (!requestAllowed(req, `pickup-${creator.id}`, 20)) { res.status(429).json({ error: "Za dużo prób potwierdzenia. Spróbuj ponownie później." }); return; }
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!reservationId || !/^\d{8}$/.test(code)) { res.status(400).json({ error: "Wpisz ośmiocyfrowy kod odbioru." }); return; }
  const result = await withTransaction(async (client) => {
    await releaseExpired(client);
    const row = await client.query(
      "SELECT id, offer_id, status, payment_status, pickup_code_hash, pickup_expires_at FROM marketplace_reservations WHERE id = $1 AND creator_user_id = $2 FOR UPDATE",
      [reservationId, creator.id],
    );
    const reservation = row.rows[0];
    const valid = matchesPickupCode(code, reservation?.pickup_code_hash ?? "");
    if (!reservation || !canConfirmPickup(reservation.status, reservation.pickup_expires_at) || !valid) return null;
    const updated = await client.query(
      `UPDATE marketplace_reservations SET status = 'picked_up', pickup_code_hash = '', pickup_code_ciphertext = NULL,
        picked_up_at = now(), updated_at = now()
        WHERE id = $1 AND status IN ('pickup_ready', 'paid') AND payment_status IN ('paid', 'not_required') AND pickup_expires_at > now() RETURNING guest_session_hash`,
      [reservationId],
    );
    if (!updated.rows[0]) return null;
    await client.query(
      `INSERT INTO marketplace_events (actor_user_id, guest_session_hash, offer_id, reservation_id, event_type)
       VALUES ($1, $2, $3, $4, 'reservation_picked_up')`,
      [creator.id, updated.rows[0].guest_session_hash, reservation.offer_id, reservationId],
    );
    return { reservationId };
  });
  if (!result) { res.status(409).json({ error: "Kod jest nieprawidłowy, wygasł lub został już użyty." }); return; }
  const transfer = await transferMarketplaceAfterPickup(result.reservationId);
  res.json({ ok: true, status: "picked_up", transferStatus: transfer.transferred ? "transferred" : "pending" });
});

router.post("/marketplace/reservations/:reservationId/rating", async (req, res): Promise<void> => {
  if (!publicWriteGuard(req, res)) return;
  const guestHash = getGuestHash(req, res, false);
  const reservationId = parseOfferId(req.params.reservationId);
  const vote = Number(req.body?.vote);
  if (!guestHash || !reservationId || (vote !== 1 && vote !== -1)) { res.status(400).json({ error: "Wybierz kciuk w górę albo w dół." }); return; }
  const result = await withTransaction(async (client) => {
    const row = await client.query("SELECT id, creator_user_id FROM marketplace_reservations WHERE id = $1 AND guest_session_hash = $2 AND status = 'picked_up' FOR UPDATE", [reservationId, guestHash]);
    if (!row.rows[0]) return false;
    const inserted = await client.query(
      `INSERT INTO marketplace_ratings (reservation_id, creator_user_id, guest_session_hash, vote)
       VALUES ($1, $2, $3, $4) ON CONFLICT (reservation_id) DO NOTHING RETURNING id`,
      [reservationId, row.rows[0].creator_user_id, guestHash, vote],
    );
    return Boolean(inserted.rows[0]);
  });
  if (!result) { res.status(409).json({ error: "Ta rezerwacja została już oceniona albo nie jest zakończona." }); return; }
  res.status(201).json({ ok: true });
});

router.post("/marketplace/requests", async (req, res): Promise<void> => {
  if (!publicWriteGuard(req, res)) return;
  if (!requestAllowed(req, "request", 3)) { res.status(429).json({ error: "Za dużo zgłoszeń. Spróbuj ponownie za minutę." }); return; }
  const body = req.body ?? {};
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const category = typeof body.category === "string" ? body.category.trim().slice(0, 50) : null;
  const budgetPln = body.budgetPln === "" || body.budgetPln == null ? null : Number(body.budgetPln);
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const radiusKm = Number(body.radiusKm);
  const neededBy = body.neededBy ? new Date(body.neededBy) : null;
  if (description.length < 10 || description.length > 1000 || !validCoordinates(lat, lng) || !Number.isSafeInteger(radiusKm) || radiusKm < 1 || radiusKm > 50 ||
      (budgetPln !== null && (!Number.isFinite(budgetPln) || budgetPln < 0 || budgetPln > 1_000_000)) ||
      (neededBy && (!Number.isFinite(neededBy.getTime()) || neededBy <= new Date()))) {
    res.status(400).json({ error: "Sprawdź opis, lokalizację, promień, budżet i termin." }); return;
  }
  const guestHash = getGuestHash(req, res, true)!;
  const result = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [guestHash]);
    const count = await client.query("SELECT count(*)::int AS count FROM marketplace_requests WHERE guest_session_hash = $1 AND created_at > now() - interval '24 hours'", [guestHash]);
    if (Number(count.rows[0]?.count) >= 3) return null;
    const request = await client.query(
      `INSERT INTO marketplace_requests (guest_session_hash, category, description, budget_cents, lat, lng, radius_km, needed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, status, created_at AS "createdAt"`,
      [guestHash, category || null, description, budgetPln === null ? null : Math.round(budgetPln * 100), normalizeCoordinates(lat, lng, 2)!.lat, normalizeCoordinates(lat, lng, 2)!.lng, radiusKm, neededBy],
    );
    await client.query("INSERT INTO marketplace_events (guest_session_hash, request_id, event_type) VALUES ($1, $2, 'request_created')", [guestHash, request.rows[0].id]);
    return request.rows[0];
  });
  if (!result) { res.status(429).json({ error: "Możesz wysłać maksymalnie 3 zapytania dziennie z tej przeglądarki." }); return; }
  res.status(201).json(result);
});

router.get("/marketplace/requests/guest", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const guestHash = getGuestHash(req, res, false);
  if (!guestHash) { res.json([]); return; }
  const result = await pool.query(
    `SELECT r.id, r.category, r.description, r.budget_cents AS "budgetCents", r.radius_km AS "radiusKm",
            r.needed_by AS "neededBy", r.status, r.created_at AS "createdAt",
            COALESCE(json_agg(json_build_object('id', p.id, 'message', p.message, 'createdAt', p.created_at,
              'creatorName', u.name, 'offerTitle', m.title, 'priceCents', o.price_cents, 'offerId', o.id))
              FILTER (WHERE p.id IS NOT NULL), '[]'::json) AS proposals
       FROM marketplace_requests r LEFT JOIN marketplace_proposals p ON p.request_id = r.id
       LEFT JOIN users u ON u.id = p.creator_user_id LEFT JOIN marketplace_offers o ON o.id = p.offer_id
       LEFT JOIN markers m ON m.id = o.marker_id
      WHERE r.guest_session_hash = $1 GROUP BY r.id ORDER BY r.created_at DESC LIMIT 30`,
    [guestHash],
  );
  res.json(result.rows);
});

router.get("/marketplace/mine/requests", requireRole("admin"), async (req, res): Promise<void> => {
  const creator = res.locals.adminUser as AdminUser;
  const distance = distanceBetweenSql("m.lat", "m.lng", "r.lat", "r.lng");
  const result = await pool.query(
    `SELECT DISTINCT r.id, r.category, r.description, r.budget_cents AS "budgetCents",
           r.radius_km AS "radiusKm", r.lat, r.lng, r.needed_by AS "neededBy", r.created_at AS "createdAt"
       FROM marketplace_requests r
       JOIN markers m ON m.owner_user_id = $1 AND m.archived_at IS NULL
       JOIN marketplace_offers o ON o.marker_id = m.id AND o.status = 'active'
      WHERE r.status = 'open'
        AND (r.category IS NULL OR m.category IS NULL OR lower(r.category) = lower(m.category))
        AND (r.budget_cents IS NULL OR o.price_cents <= r.budget_cents)
        AND ${distance} <= r.radius_km
        AND NOT EXISTS (SELECT 1 FROM marketplace_proposals p WHERE p.request_id = r.id AND p.creator_user_id = $1)
      ORDER BY r.created_at DESC LIMIT 100`,
    [creator.id],
  );
  res.json(result.rows);
});

router.post("/marketplace/requests/:requestId/proposals", requireRole("admin"), async (req, res): Promise<void> => {
  const creator = res.locals.adminUser as AdminUser;
  const requestId = parseOfferId(req.params.requestId);
  const offerId = Number(req.body?.offerId);
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!requestId || !Number.isSafeInteger(offerId) || offerId < 1 || message.length < 5 || message.length > 500) {
    res.status(400).json({ error: "Wybierz własną ofertę i wpisz krótką wiadomość." }); return;
  }
  const result = await pool.query(
    `INSERT INTO marketplace_proposals (request_id, creator_user_id, offer_id, message)
     SELECT r.id, $2, o.id, $4 FROM marketplace_requests r
     JOIN marketplace_offers o ON o.id = $3 AND o.creator_user_id = $2 AND o.status = 'active'
     JOIN markers m ON m.id = o.marker_id AND m.archived_at IS NULL
     WHERE r.id = $1 AND r.status = 'open'
       AND (r.category IS NULL OR m.category IS NULL OR lower(r.category) = lower(m.category))
       AND (r.budget_cents IS NULL OR o.price_cents <= r.budget_cents)
       AND ${distanceBetweenSql("m.lat", "m.lng", "r.lat", "r.lng")} <= r.radius_km
     ON CONFLICT (request_id, creator_user_id) DO NOTHING
     RETURNING id`,
    [requestId, creator.id, offerId, message],
  );
  if (!result.rows[0]) { res.status(409).json({ error: "Nie udało się wysłać propozycji. Sprawdź dopasowanie oferty i zgłoszenia." }); return; }
  await pool.query("INSERT INTO marketplace_events (actor_user_id, request_id, event_type) VALUES ($1, $2, 'proposal_created')", [creator.id, requestId]);
  res.status(201).json({ id: result.rows[0].id });
});

router.get("/marketplace/analytics", requireRole("admin"), async (_req, res): Promise<void> => {
  const creator = res.locals.adminUser as AdminUser;
  const result = await pool.query(
    `SELECT o.id, m.title, o.price_cents AS "priceCents", o.quantity_total AS "quantityTotal",
        o.quantity_available AS "quantityAvailable",
        count(e.id) FILTER (WHERE e.event_type = 'offer_view')::int AS views,
        count(e.id) FILTER (WHERE e.event_type = 'reservation_requested')::int AS requests,
        count(e.id) FILTER (WHERE e.event_type = 'reservation_accepted')::int AS accepted,
        count(e.id) FILTER (WHERE e.event_type = 'reservation_rejected')::int AS rejected,
        count(e.id) FILTER (WHERE e.event_type = 'reservation_picked_up')::int AS picked_up
       FROM marketplace_offers o JOIN markers m ON m.id = o.marker_id
       LEFT JOIN marketplace_events e ON e.offer_id = o.id
      WHERE o.creator_user_id = $1 GROUP BY o.id, m.title ORDER BY o.created_at DESC`,
    [creator.id],
  );
  res.json(result.rows);
});

router.get("/marketplace/creator-context", requireRole("admin"), async (_req, res): Promise<void> => {
  const creator = res.locals.adminUser as AdminUser;
  const result = await pool.query(
    `SELECT id, title, category, lat, lng FROM markers
      WHERE owner_user_id = $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 200`,
    [creator.id],
  );
  res.json(result.rows);
});

export default router;

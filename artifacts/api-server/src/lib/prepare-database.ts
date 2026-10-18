import { eq } from "drizzle-orm";
import { db, pool, usersTable } from "@workspace/db";
import { logger } from "./logger";
import { hashPassword, isPasswordHash } from "./password";

export async function prepareDatabase(): Promise<void> {
  // Additive multi-tenant/RBAC migration. Existing maps are assigned to the
  // oldest admin so the first deployment preserves the current account's data.
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS slug text");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_user_id integer");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_balance integer NOT NULL DEFAULT 10");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS first_purchase_bonus_granted boolean NOT NULL DEFAULT false");
  await pool.query("ALTER TABLE markers ADD COLUMN IF NOT EXISTS owner_user_id integer");
  await pool.query(`UPDATE users SET slug = 'konto-' || id WHERE slug IS NULL OR slug = ''`);
  await pool.query("ALTER TABLE users ALTER COLUMN slug SET NOT NULL");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS users_slug_unique ON users (slug)");
  await pool.query(`UPDATE markers SET owner_user_id = (
    SELECT id FROM users WHERE role IN ('admin', 'moderator', 'master_admin') ORDER BY id LIMIT 1
  ) WHERE owner_user_id IS NULL`);
  await pool.query("ALTER TABLE markers ALTER COLUMN owner_user_id SET NOT NULL");
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'markers_owner_user_id_fkey') THEN
      ALTER TABLE markers ADD CONSTRAINT markers_owner_user_id_fkey
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_pin_balance_nonnegative') THEN
      ALTER TABLE users ADD CONSTRAINT users_pin_balance_nonnegative CHECK (pin_balance >= 0);
    END IF;
  END $$`);
  await pool.query("CREATE INDEX IF NOT EXISTS markers_owner_user_id_idx ON markers (owner_user_id)");
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (
    id serial PRIMARY KEY,
    actor_user_id integer,
    tenant_user_id integer,
    event_type text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS audit_logs_tenant_user_id_idx ON audit_logs (tenant_user_id)");

  await pool.query(`CREATE TABLE IF NOT EXISTS stripe_pin_purchases (
    id serial PRIMARY KEY,
    creator_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    stripe_session_id text NOT NULL,
    stripe_payment_intent_id text,
    package_id text NOT NULL,
    pins integer NOT NULL CHECK (pins > 0),
    amount_cents integer NOT NULL CHECK (amount_cents > 0),
    currency text NOT NULL DEFAULT 'pln',
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
    created_at timestamptz NOT NULL DEFAULT now(),
    paid_at timestamptz
  )`);
  await pool.query("ALTER TABLE stripe_pin_purchases ADD COLUMN IF NOT EXISTS bonus_pins integer NOT NULL DEFAULT 0");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS stripe_pin_purchases_session_unique ON stripe_pin_purchases (stripe_session_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS stripe_pin_purchases_creator_created_idx ON stripe_pin_purchases (creator_user_id, created_at)");
  await pool.query(`CREATE TABLE IF NOT EXISTS account_invites (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS account_invites_user_id_idx ON account_invites (user_id)");
  await pool.query(`CREATE TABLE IF NOT EXISTS pin_topups (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    granted_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    package_id text NOT NULL,
    pins integer NOT NULL CHECK (pins > 0),
    price_pln integer NOT NULL CHECK (price_pln > 0),
    payment_reference text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS pin_topups_user_id_idx ON pin_topups (user_id)");
  // Legacy administrator-confirmed top-ups also count as a creator's first purchase.
  await pool.query(`UPDATE users SET first_purchase_bonus_granted = true
    WHERE first_purchase_bonus_granted = false AND (
      EXISTS (SELECT 1 FROM stripe_pin_purchases p WHERE p.creator_user_id = users.id AND p.status = 'paid')
      OR EXISTS (SELECT 1 FROM pin_topups t WHERE t.user_id = users.id)
    )`);

  await pool.query(
    "ALTER TABLE markers ADD COLUMN IF NOT EXISTS archived_at timestamptz",
  );
  await pool.query("ALTER TABLE markers ADD COLUMN IF NOT EXISTS category text");
  await pool.query("ALTER TABLE stripe_pin_purchases ADD COLUMN IF NOT EXISTS refund_amount_cents integer NOT NULL DEFAULT 0");
  await pool.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS markers_created_at_idx ON markers (created_at DESC)");
  await pool.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS markers_owner_created_idx ON markers (owner_user_id, created_at DESC)");
  await pool.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS markers_lat_lng_idx ON markers (lat, lng)");
  await pool.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS markers_category_idx ON markers (category)");
  await pool.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS users_created_at_idx ON users (created_at DESC)");
  await pool.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_actor_created_idx ON audit_logs (actor_user_id, created_at DESC)");
  await pool.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_tenant_created_idx ON audit_logs (tenant_user_id, created_at DESC)");
  await pool.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_event_created_idx ON audit_logs (event_type, created_at DESC)");
  await pool.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS stripe_pin_purchases_created_status_idx ON stripe_pin_purchases (created_at DESC, status)");
  await pool.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS stripe_pin_purchases_payment_intent_idx ON stripe_pin_purchases (stripe_payment_intent_id)");
  await pool.query("CREATE INDEX CONCURRENTLY IF NOT EXISTS stripe_pin_purchases_creator_paid_idx ON stripe_pin_purchases (creator_user_id, paid_at DESC)");

  // Additive marketplace tables. Existing markers and guest token redemptions
  // remain unchanged; offers are optional records attached to a creator-owned
  // marker. Quantity is held atomically when a reservation is requested.
  await pool.query(`CREATE TABLE IF NOT EXISTS marketplace_offers (
    id serial PRIMARY KEY,
    marker_id integer NOT NULL UNIQUE REFERENCES markers(id) ON DELETE RESTRICT,
    creator_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    price_cents integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
    currency text NOT NULL DEFAULT 'pln' CHECK (currency = 'pln'),
    quantity_total integer NOT NULL CHECK (quantity_total > 0),
    quantity_available integer NOT NULL CHECK (quantity_available >= 0),
    pickup_details text NOT NULL,
    pickup_until timestamptz,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (quantity_available <= quantity_total)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS marketplace_reservations (
    id serial PRIMARY KEY,
    offer_id integer NOT NULL REFERENCES marketplace_offers(id) ON DELETE RESTRICT,
    request_id integer,
    proposal_id integer,
    creator_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    guest_session_hash text NOT NULL,
    quantity integer NOT NULL DEFAULT 1 CHECK (quantity = 1),
    price_cents integer NOT NULL CHECK (price_cents >= 0),
    currency text NOT NULL DEFAULT 'pln' CHECK (currency = 'pln'),
    status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'payment_pending', 'paid', 'pickup_ready', 'rejected', 'cancelled', 'expired', 'picked_up', 'refunded', 'disputed')),
    pickup_code_hash text NOT NULL,
    response_deadline timestamptz NOT NULL,
    pickup_expires_at timestamptz,
    requested_at timestamptz NOT NULL DEFAULT now(),
    accepted_at timestamptz,
    picked_up_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS marketplace_requests (
    id serial PRIMARY KEY,
    guest_session_hash text NOT NULL,
    category text,
    description text NOT NULL,
    budget_cents integer CHECK (budget_cents IS NULL OR budget_cents >= 0),
    lat double precision NOT NULL CHECK (lat >= -90 AND lat <= 90),
    lng double precision NOT NULL CHECK (lng >= -180 AND lng <= 180),
    radius_km numeric(6,3) NOT NULL CHECK (radius_km BETWEEN 0.1 AND 50),
    needed_by timestamptz,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled', 'expired')),
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS marketplace_proposals (
    id serial PRIMARY KEY,
    request_id integer NOT NULL REFERENCES marketplace_requests(id) ON DELETE CASCADE,
    creator_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    offer_id integer NOT NULL REFERENCES marketplace_offers(id) ON DELETE RESTRICT,
    message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (request_id, creator_user_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS marketplace_events (
    id bigserial PRIMARY KEY,
    actor_user_id integer REFERENCES users(id) ON DELETE SET NULL,
    guest_session_hash text,
    offer_id integer REFERENCES marketplace_offers(id) ON DELETE SET NULL,
    reservation_id integer REFERENCES marketplace_reservations(id) ON DELETE SET NULL,
    request_id integer REFERENCES marketplace_requests(id) ON DELETE SET NULL,
    event_type text NOT NULL CHECK (event_type IN ('offer_view', 'reservation_requested', 'reservation_accepted', 'reservation_rejected', 'reservation_cancelled', 'reservation_expired', 'reservation_picked_up', 'request_created', 'proposal_created', 'proposal_accepted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    view_day date NOT NULL DEFAULT CURRENT_DATE,
    details jsonb NOT NULL DEFAULT '{}'::jsonb
  )`);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS marketplace_offer_view_once_daily ON marketplace_events (offer_id, guest_session_hash, view_day) WHERE event_type = 'offer_view' AND guest_session_hash IS NOT NULL");
  await pool.query("CREATE INDEX IF NOT EXISTS marketplace_offers_status_location_idx ON marketplace_offers (status, pickup_until)");
  await pool.query("CREATE INDEX IF NOT EXISTS marketplace_offers_creator_idx ON marketplace_offers (creator_user_id, updated_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS marketplace_reservations_creator_status_idx ON marketplace_reservations (creator_user_id, status, response_deadline)");
  await pool.query("CREATE INDEX IF NOT EXISTS marketplace_reservations_guest_idx ON marketplace_reservations (guest_session_hash, requested_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS marketplace_requests_created_idx ON marketplace_requests (status, created_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS marketplace_proposals_request_idx ON marketplace_proposals (request_id, created_at)");
  await pool.query("CREATE INDEX IF NOT EXISTS marketplace_events_offer_idx ON marketplace_events (offer_id, event_type, created_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS marketplace_events_creator_idx ON marketplace_events (actor_user_id, event_type, created_at DESC)");

  // The recipient-request flow uses a fixed 500 m placement radius. These
  // additive migrations also make proposal acceptance idempotent: a refresh
  // cannot create a second reservation or charge the recipient twice.
  await pool.query(`DO $$ BEGIN
    ALTER TABLE marketplace_requests ALTER COLUMN radius_km TYPE numeric(6,3) USING radius_km::numeric;
  EXCEPTION WHEN duplicate_column THEN NULL;
  END $$`);
  await pool.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_requests_radius_km_check') THEN
      ALTER TABLE marketplace_requests DROP CONSTRAINT marketplace_requests_radius_km_check;
    END IF;
    ALTER TABLE marketplace_requests ADD CONSTRAINT marketplace_requests_radius_km_check CHECK (radius_km BETWEEN 0.1 AND 50);
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`);
  await pool.query("ALTER TABLE marketplace_reservations ADD COLUMN IF NOT EXISTS request_id integer");
  await pool.query("ALTER TABLE marketplace_reservations ADD COLUMN IF NOT EXISTS proposal_id integer");
  await pool.query(`DO $$ BEGIN
    ALTER TABLE marketplace_reservations ADD CONSTRAINT marketplace_reservations_request_fk FOREIGN KEY (request_id) REFERENCES marketplace_requests(id) ON DELETE SET NULL;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS marketplace_reservations_proposal_unique ON marketplace_reservations (proposal_id) WHERE proposal_id IS NOT NULL");
  await pool.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_events_event_type_check') THEN
      ALTER TABLE marketplace_events DROP CONSTRAINT marketplace_events_event_type_check;
    END IF;
    ALTER TABLE marketplace_events ADD CONSTRAINT marketplace_events_event_type_check CHECK (event_type IN ('offer_view', 'reservation_requested', 'reservation_accepted', 'reservation_rejected', 'reservation_cancelled', 'reservation_expired', 'reservation_picked_up', 'request_created', 'proposal_created', 'proposal_accepted'));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`);

  // Marketplace payments use Stripe Connect separate charges and transfers:
  // Stripe holds the platform charge until pickup, then the application sends
  // the creator's net amount to the connected account. These columns are
  // additive so existing reservations remain readable and cancellable.
  await pool.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_reservations_status_check') THEN
      ALTER TABLE marketplace_reservations DROP CONSTRAINT marketplace_reservations_status_check;
    END IF;
    ALTER TABLE marketplace_reservations ADD CONSTRAINT marketplace_reservations_status_check
      CHECK (status IN ('requested', 'accepted', 'payment_pending', 'paid', 'pickup_ready', 'rejected', 'cancelled', 'expired', 'picked_up', 'refunded', 'disputed'));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`);
  await pool.query("ALTER TABLE marketplace_reservations ADD COLUMN IF NOT EXISTS pickup_code_ciphertext text");
  await pool.query("ALTER TABLE marketplace_reservations ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text");
  await pool.query("ALTER TABLE marketplace_reservations ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text");
  await pool.query("ALTER TABLE marketplace_reservations ADD COLUMN IF NOT EXISTS stripe_transfer_id text");
  await pool.query("ALTER TABLE marketplace_reservations ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'not_required'");
  await pool.query("ALTER TABLE marketplace_reservations ADD COLUMN IF NOT EXISTS gross_amount_cents integer NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE marketplace_reservations ADD COLUMN IF NOT EXISTS platform_fee_cents integer NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE marketplace_reservations ADD COLUMN IF NOT EXISTS creator_net_cents integer NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE marketplace_reservations ADD COLUMN IF NOT EXISTS paid_at timestamptz");
  await pool.query("ALTER TABLE marketplace_reservations ADD COLUMN IF NOT EXISTS transferred_at timestamptz");
  await pool.query("ALTER TABLE marketplace_reservations ADD COLUMN IF NOT EXISTS refunded_at timestamptz");
  await pool.query("ALTER TABLE marketplace_reservations ADD COLUMN IF NOT EXISTS disputed_at timestamptz");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS marketplace_reservations_checkout_unique ON marketplace_reservations (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS marketplace_reservations_payment_intent_unique ON marketplace_reservations (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL");
  await pool.query(`CREATE TABLE IF NOT EXISTS marketplace_stripe_accounts (
    user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    stripe_account_id text NOT NULL UNIQUE,
    onboarding_status text NOT NULL DEFAULT 'not_started',
    charges_enabled boolean NOT NULL DEFAULT false,
    payouts_enabled boolean NOT NULL DEFAULT false,
    requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS marketplace_stripe_events (
    event_id text PRIMARY KEY,
    event_type text NOT NULL,
    reservation_id integer REFERENCES marketplace_reservations(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS marketplace_ratings (
    id serial PRIMARY KEY,
    reservation_id integer NOT NULL UNIQUE REFERENCES marketplace_reservations(id) ON DELETE CASCADE,
    creator_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    guest_session_hash text NOT NULL,
    vote smallint NOT NULL CHECK (vote IN (-1, 1)),
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS marketplace_ratings_creator_idx ON marketplace_ratings (creator_user_id, created_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS marketplace_stripe_events_reservation_idx ON marketplace_stripe_events (reservation_id)");

  const admins = await db
    .select({ id: usersTable.id, passwordHash: usersTable.passwordHash })
    .from(usersTable)
    .where(eq(usersTable.role, "admin"));

  for (const admin of admins) {
    if (isPasswordHash(admin.passwordHash)) continue;
    await db
      .update(usersTable)
      .set({ passwordHash: await hashPassword(admin.passwordHash) })
      .where(eq(usersTable.id, admin.id));
  }

  const duplicateRedemptions = await pool.query(
    `SELECT 1
       FROM redemptions
      GROUP BY user_id, marker_id
     HAVING COUNT(*) > 1
      LIMIT 1`,
  );

  if (duplicateRedemptions.rowCount === 0) {
    await pool.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS redemptions_user_marker_unique ON redemptions (user_id, marker_id)",
    );
  } else {
    logger.warn(
      "Existing duplicate redemptions were preserved; new writes are serialized and protected by the application.",
    );
  }
}

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
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS stripe_pin_purchases_session_unique ON stripe_pin_purchases (stripe_session_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS stripe_pin_purchases_creator_created_idx ON stripe_pin_purchases (creator_user_id, created_at)");

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

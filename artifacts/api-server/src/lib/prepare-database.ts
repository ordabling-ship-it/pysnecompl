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

  await pool.query(
    "ALTER TABLE markers ADD COLUMN IF NOT EXISTS archived_at timestamptz",
  );

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

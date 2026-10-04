import { eq } from "drizzle-orm";
import { db, pool, usersTable } from "@workspace/db";
import { logger } from "./logger";
import { hashPassword, isPasswordHash } from "./password";

export async function prepareDatabase(): Promise<void> {
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

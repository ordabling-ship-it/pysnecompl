import { Router, type IRouter } from "express";
import { sql, gte, isNotNull, and, desc, eq } from "drizzle-orm";
import { db, markersTable, settingsTable } from "@workspace/db";

const router: IRouter = Router();

// Singleton settings row id. ALL reads/updates are hard-scoped to this id so
// that, even if a stray row appears, behavior stays deterministic and reset
// only ever touches the canonical row.
const SETTINGS_ID = 1;

// Get-or-create the singleton settings row. Drizzle has no upsert helper that
// returns the existing row when there's a conflict — so we read first, then
// insert with onConflictDoNothing if missing, then re-read.
async function getSettings() {
  const [existing] = await db.select().from(settingsTable).where(eq(settingsTable.id, SETTINGS_ID));
  if (existing) return existing;
  await db
    .insert(settingsTable)
    .values({ id: SETTINGS_ID })
    .onConflictDoNothing();
  const [fresh] = await db.select().from(settingsTable).where(eq(settingsTable.id, SETTINGS_ID));
  return fresh!;
}

router.get("/discoveries", async (_req, res): Promise<void> => {
  const settings = await getSettings();
  const since = settings.discoveriesResetAt;

  // Total activations since the last reset
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(markersTable)
    .where(and(isNotNull(markersTable.activatedAt), gte(markersTable.activatedAt, since)));

  // 5 most recent activations since the last reset, newest first
  const recent = await db
    .select({ code: markersTable.code, activatedAt: markersTable.activatedAt })
    .from(markersTable)
    .where(and(isNotNull(markersTable.activatedAt), gte(markersTable.activatedAt, since)))
    .orderBy(desc(markersTable.activatedAt))
    .limit(5);

  res.json({
    count,
    lastResetAt: since.toISOString(),
    recent: recent.map((r) => ({
      code: r.code,
      activatedAt: r.activatedAt!.toISOString(),
    })),
  });
});

router.post("/discoveries/reset", async (req, res): Promise<void> => {
  await getSettings();
  const now = new Date();
  // Hard-scope the update to the singleton row.
  await db
    .update(settingsTable)
    .set({ discoveriesResetAt: now })
    .where(eq(settingsTable.id, SETTINGS_ID));
  req.log.info({ resetAt: now }, "Discoveries counter reset by admin");
  res.json({ lastResetAt: now.toISOString() });
});

export default router;

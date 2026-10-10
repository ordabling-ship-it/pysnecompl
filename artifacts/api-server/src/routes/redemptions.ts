import { Router, type IRouter } from "express";
import { eq, and, sql, isNull } from "drizzle-orm";
import { db, redemptionsTable, markersTable } from "@workspace/db";
import {
  CreateRedemptionBody,
  ListRedemptionsQueryParams,
} from "@workspace/api-zod";
import { requireAdmin, type AdminUser } from "../lib/admin-session";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();
router.use(requireAdmin);

router.get("/redemptions", async (req, res): Promise<void> => {
  const admin = res.locals.adminUser as AdminUser;
  const params = ListRedemptionsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  let query = db
    .select({
      id: redemptionsTable.id,
      userId: redemptionsTable.userId,
      markerId: redemptionsTable.markerId,
      markerTitle: markersTable.title,
      redeemedAt: redemptionsTable.redeemedAt,
    })
    .from(redemptionsTable)
    .innerJoin(markersTable, eq(redemptionsTable.markerId, markersTable.id));

  if (params.data.userId != null) {
    const redemptions = await query.where(and(eq(redemptionsTable.userId, params.data.userId), eq(markersTable.ownerUserId, admin.id)));
    res.json(
      redemptions.map((r) => ({
        ...r,
        redeemedAt: r.redeemedAt.toISOString(),
      }))
    );
    return;
  }

  const redemptions = await query.where(eq(markersTable.ownerUserId, admin.id));
  res.json(
    redemptions.map((r) => ({
      ...r,
      redeemedAt: r.redeemedAt.toISOString(),
    }))
  );
});

router.post("/redemptions", async (req, res): Promise<void> => {
  const admin = res.locals.adminUser as AdminUser;
  const parsed = CreateRedemptionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { userId, code } = parsed.data;
  if (userId !== admin.id) {
    res.status(403).json({ error: "Nie możesz zapisać odkrycia dla innego konta." });
    return;
  }
  const upperCode = code.toUpperCase();

  const [marker] = await db
    .select()
    .from(markersTable)
    .where(and(
      eq(markersTable.code, upperCode),
      isNull(markersTable.archivedAt),
      eq(markersTable.ownerUserId, admin.id),
    ));

  if (!marker) {
    res.status(400).json({ error: "Nieprawidłowy kod" });
    return;
  }

  // Null expiresAt means no guest has activated the timer yet — still valid.
  if (marker.expiresAt && new Date() > new Date(marker.expiresAt)) {
    res.status(400).json({ error: "Ten skarb już wygasł!" });
    return;
  }

  const redemption = await db.transaction(async (tx) => {
    // Serialize this user/marker pair across server instances. The unique
    // index is an additional database-level guard when existing data permits it.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${userId}, ${marker.id})`);

    const [existing] = await tx
      .select()
      .from(redemptionsTable)
      .where(and(
        eq(redemptionsTable.userId, userId),
        eq(redemptionsTable.markerId, marker.id),
      ));
    if (existing) return null;

    const [created] = await tx
      .insert(redemptionsTable)
      .values({ userId, markerId: marker.id })
      .onConflictDoNothing()
      .returning();
    return created ?? null;
  });

  if (!redemption) {
    res.status(400).json({ error: "Ta moneta już odblokowana!" });
    return;
  }

  req.log.info({ userId, markerId: marker.id }, "Code redeemed");
  await recordAudit("code_redeemed", admin.id, admin.id, { markerId: marker.id, redemptionId: redemption.id });
  res.status(201).json({
    id: redemption.id,
    userId: redemption.userId,
    markerId: redemption.markerId,
    markerTitle: marker.title,
    redeemedAt: redemption.redeemedAt.toISOString(),
  });
});

export default router;

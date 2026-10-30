import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, redemptionsTable, markersTable } from "@workspace/db";
import {
  ListRedemptionsQueryParams,
} from "@workspace/api-zod";
import { requireAdmin, type AdminUser } from "../lib/admin-session";

const router: IRouter = Router();

router.get("/redemptions", requireAdmin, async (req, res): Promise<void> => {
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

export default router;

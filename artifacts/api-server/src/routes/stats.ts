import { Router, type IRouter } from "express";
import { db, markersTable, redemptionsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/stats", async (_req, res): Promise<void> => {
  const [markerStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where expires_at > now())::int`,
      expired: sql<number>`count(*) filter (where expires_at <= now())::int`,
    })
    .from(markersTable);

  const [redemptionStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
    })
    .from(redemptionsTable);

  res.json({
    totalMarkers: markerStats?.total ?? 0,
    activeMarkers: markerStats?.active ?? 0,
    expiredMarkers: markerStats?.expired ?? 0,
    totalRedemptions: redemptionStats?.total ?? 0,
  });
});

export default router;

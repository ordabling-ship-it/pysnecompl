import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, redemptionsTable, markersTable } from "@workspace/db";
import {
  CreateRedemptionBody,
  ListRedemptionsQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/redemptions", async (req, res): Promise<void> => {
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
    const redemptions = await query.where(eq(redemptionsTable.userId, params.data.userId));
    res.json(
      redemptions.map((r) => ({
        ...r,
        redeemedAt: r.redeemedAt.toISOString(),
      }))
    );
    return;
  }

  const redemptions = await query;
  res.json(
    redemptions.map((r) => ({
      ...r,
      redeemedAt: r.redeemedAt.toISOString(),
    }))
  );
});

router.post("/redemptions", async (req, res): Promise<void> => {
  const parsed = CreateRedemptionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { userId, code } = parsed.data;
  const upperCode = code.toUpperCase();

  const [marker] = await db
    .select()
    .from(markersTable)
    .where(eq(markersTable.code, upperCode));

  if (!marker) {
    res.status(400).json({ error: "Nieprawidłowy kod" });
    return;
  }

  // Null expiresAt means no guest has activated the timer yet — still valid.
  if (marker.expiresAt && new Date() > new Date(marker.expiresAt)) {
    res.status(400).json({ error: "Ten skarb już wygasł!" });
    return;
  }

  const [existing] = await db
    .select()
    .from(redemptionsTable)
    .where(
      and(
        eq(redemptionsTable.userId, userId),
        eq(redemptionsTable.markerId, marker.id)
      )
    );

  if (existing) {
    res.status(400).json({ error: "Ta moneta już odblokowana!" });
    return;
  }

  const [redemption] = await db
    .insert(redemptionsTable)
    .values({ userId, markerId: marker.id })
    .returning();

  req.log.info({ userId, markerId: marker.id }, "Code redeemed");
  res.status(201).json({
    id: redemption.id,
    userId: redemption.userId,
    markerId: redemption.markerId,
    markerTitle: marker.title,
    redeemedAt: redemption.redeemedAt.toISOString(),
  });
});

export default router;

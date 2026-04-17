import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, markersTable, redemptionsTable } from "@workspace/db";
import {
  CreateMarkerBody,
  GetMarkerParams,
  DeleteMarkerParams,
  GetMarkerByCodeParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function genCode(): string {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function markerWithRedemptionCount(marker: typeof markersTable.$inferSelect, count: number) {
  return {
    id: marker.id,
    title: marker.title,
    description: marker.description,
    code: marker.code,
    lat: marker.lat,
    lng: marker.lng,
    imageUrl: marker.imageUrl ?? null,
    createdAt: marker.createdAt.toISOString(),
    expiresAt: marker.expiresAt.toISOString(),
    redemptionCount: count,
  };
}

router.get("/markers", async (req, res): Promise<void> => {
  const markers = await db.select().from(markersTable).orderBy(markersTable.createdAt);

  const counts = await db
    .select({
      markerId: redemptionsTable.markerId,
      count: sql<number>`count(*)::int`,
    })
    .from(redemptionsTable)
    .groupBy(redemptionsTable.markerId);

  const countMap = new Map(counts.map((c) => [c.markerId, c.count]));

  res.json(
    markers.map((m) => markerWithRedemptionCount(m, countMap.get(m.id) ?? 0))
  );
});

router.post("/markers", async (req, res): Promise<void> => {
  const parsed = CreateMarkerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { title, description, lat, lng, imageUrl } = parsed.data;
  const code = genCode();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  const [marker] = await db
    .insert(markersTable)
    .values({ title, description, lat, lng, imageUrl: imageUrl ?? null, code, expiresAt })
    .returning();

  req.log.info({ markerId: marker.id, code }, "Marker created");
  res.status(201).json(markerWithRedemptionCount(marker, 0));
});

router.get("/markers/by-code/:code", async (req, res): Promise<void> => {
  const params = GetMarkerByCodeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [marker] = await db
    .select()
    .from(markersTable)
    .where(eq(markersTable.code, params.data.code.toUpperCase()));

  if (!marker) {
    res.status(404).json({ error: "Marker not found" });
    return;
  }

  if (new Date() > new Date(marker.expiresAt)) {
    res.status(404).json({ error: "Marker expired" });
    return;
  }

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(redemptionsTable)
    .where(eq(redemptionsTable.markerId, marker.id));

  res.json(markerWithRedemptionCount(marker, countRow?.count ?? 0));
});

router.get("/markers/:id", async (req, res): Promise<void> => {
  const params = GetMarkerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [marker] = await db
    .select()
    .from(markersTable)
    .where(eq(markersTable.id, params.data.id));

  if (!marker) {
    res.status(404).json({ error: "Marker not found" });
    return;
  }

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(redemptionsTable)
    .where(eq(redemptionsTable.markerId, marker.id));

  res.json(markerWithRedemptionCount(marker, countRow?.count ?? 0));
});

router.delete("/markers/:id", async (req, res): Promise<void> => {
  const params = DeleteMarkerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [marker] = await db
    .delete(markersTable)
    .where(eq(markersTable.id, params.data.id))
    .returning();

  if (!marker) {
    res.status(404).json({ error: "Marker not found" });
    return;
  }

  req.log.info({ markerId: params.data.id }, "Marker deleted");
  res.sendStatus(204);
});

export default router;

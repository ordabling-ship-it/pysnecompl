import { Router, type IRouter } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, markersTable, redemptionsTable } from "@workspace/db";
import { requireAdmin } from "../lib/admin-session";
import {
  CreateMarkerBody,
  GetMarkerParams,
  DeleteMarkerParams,
  GetMarkerByCodeParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

const MAX_IMAGE_URL_LENGTH = 1_500_000;

function isAllowedImageUrl(value: string): boolean {
  if (value.length > MAX_IMAGE_URL_LENGTH) return false;
  if (/^data:image\/jpeg;base64,[A-Za-z0-9+/]*={0,2}$/.test(value)) return true;

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

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
    // Null until the first guest enters the code (then it's NOW + 60min).
    expiresAt: marker.expiresAt ? marker.expiresAt.toISOString() : null,
    activatedAt: marker.activatedAt ? marker.activatedAt.toISOString() : null,
    redemptionCount: count,
  };
}

router.get("/markers", requireAdmin, async (req, res): Promise<void> => {
  // Newest first per spec — sidebar lists most recently created markers at the top.
  const markers = await db
    .select()
    .from(markersTable)
    .where(isNull(markersTable.archivedAt))
    .orderBy(sql`${markersTable.createdAt} DESC`);

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

router.post("/markers", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateMarkerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { title, description, lat, lng, imageUrl } = parsed.data;

  if (
    title.trim().length === 0 || title.length > 160 ||
    description.trim().length === 0 || description.length > 4000 ||
    !Number.isFinite(lat) || lat < -90 || lat > 90 ||
    !Number.isFinite(lng) || lng < -180 || lng > 180 ||
    (imageUrl != null && !isAllowedImageUrl(imageUrl))
  ) {
    res.status(400).json({ error: "Dane znacznika są nieprawidłowe lub przekraczają dozwolony rozmiar." });
    return;
  }

  const code = genCode();

  // IMPORTANT: admin creation does NOT start the timer. expiresAt stays null
  // until the first guest successfully enters the code (see auth.ts).
  const [marker] = await db
    .insert(markersTable)
    .values({ title, description, lat, lng, imageUrl: imageUrl ?? null, code, expiresAt: null })
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
    .where(and(
      eq(markersTable.code, params.data.code.toUpperCase()),
      isNull(markersTable.archivedAt),
    ));

  if (!marker) {
    res.status(404).json({ error: "Marker not found" });
    return;
  }

  // expiresAt is null until first discovery; treat null as "not yet expired".
  if (marker.expiresAt && new Date() > new Date(marker.expiresAt)) {
    res.status(404).json({ error: "Marker expired" });
    return;
  }

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(redemptionsTable)
    .where(eq(redemptionsTable.markerId, marker.id));

  res.json(markerWithRedemptionCount(marker, countRow?.count ?? 0));
});

router.get("/markers/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = GetMarkerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [marker] = await db
    .select()
    .from(markersTable)
    .where(sql`${markersTable.id} = ${params.data.id} AND ${markersTable.archivedAt} IS NULL`);

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

router.delete("/markers/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteMarkerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [marker] = await db
    .update(markersTable)
    .set({ archivedAt: new Date() })
    .where(sql`${markersTable.id} = ${params.data.id} AND ${markersTable.archivedAt} IS NULL`)
    .returning();

  if (!marker) {
    res.status(404).json({ error: "Marker not found" });
    return;
  }

  req.log.info({ markerId: params.data.id }, "Marker archived");
  res.sendStatus(204);
});

export default router;

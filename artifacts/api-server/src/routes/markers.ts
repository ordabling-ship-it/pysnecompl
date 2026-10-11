import { Router, type IRouter } from "express";
import { randomInt } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, markersTable, redemptionsTable, usersTable } from "@workspace/db";
import { getRoleCapabilities } from "@workspace/api-zod";
import { requireAdmin, type AdminUser } from "../lib/admin-session";
import { recordAudit } from "../lib/audit";
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
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join("");
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
  const admin = res.locals.adminUser as AdminUser;
  // Newest first per spec — sidebar lists most recently created markers at the top.
  const markers = await db
    .select()
    .from(markersTable)
    .where(and(isNull(markersTable.archivedAt), eq(markersTable.ownerUserId, admin.id)))
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
  const admin = res.locals.adminUser as AdminUser;
  const hasUnlimitedPins = getRoleCapabilities(admin.role).hasUnlimitedPins;

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

  const marker = await db.transaction(async (tx) => {
    if (!hasUnlimitedPins) {
      const [charged] = await tx.update(usersTable)
        .set({ pinBalance: sql`${usersTable.pinBalance} - 1` })
        .where(and(eq(usersTable.id, admin.id), sql`${usersTable.pinBalance} > 0`))
        .returning({ id: usersTable.id });
      if (!charged) return null;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const [created] = await tx.insert(markersTable)
        .values({ ownerUserId: admin.id, title, description, lat, lng, imageUrl: imageUrl ?? null, code: genCode(), expiresAt: null })
        .onConflictDoNothing({ target: markersTable.code })
        .returning();
      if (created) return created;
    }
    if (!hasUnlimitedPins) {
      await tx.update(usersTable).set({ pinBalance: sql`${usersTable.pinBalance} + 1` }).where(eq(usersTable.id, admin.id));
    }
    throw new Error("Unable to allocate a unique marker code");
  });

  if (!marker) {
    res.status(402).json({ error: "Wykorzystano wszystkie pinezki. Wybierz pakiet, aby dodać kolejne." });
    return;
  }

  req.log.info({ markerId: marker.id, code: marker.code, ownerUserId: admin.id }, "Marker created");
  await recordAudit("marker_created", admin.id, admin.id, { markerId: marker.id, code: marker.code, title: marker.title });
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

  const requestedTenant = typeof req.query.tenantSlug === "string" ? req.query.tenantSlug.toLowerCase() : null;
  const [owner] = await db.select({ id: usersTable.id, slug: usersTable.slug })
    .from(usersTable).where(eq(usersTable.id, marker.ownerUserId));
  const defaultTenant = requestedTenant ? undefined : (await db.select({ id: usersTable.id })
    .from(usersTable).where(eq(usersTable.role, "admin")).orderBy(usersTable.id).limit(1))[0];
  if (!owner || (requestedTenant ? owner.slug !== requestedTenant : defaultTenant?.id !== owner.id)) {
    res.status(404).json({ error: "Nie znaleziono znacznika na tej mapie." });
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
    .where(and(eq(markersTable.id, params.data.id), eq(markersTable.ownerUserId, (res.locals.adminUser as AdminUser).id), isNull(markersTable.archivedAt)));

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
    .where(and(eq(markersTable.id, params.data.id), eq(markersTable.ownerUserId, (res.locals.adminUser as AdminUser).id), isNull(markersTable.archivedAt)))
    .returning();

  if (!marker) {
    res.status(404).json({ error: "Marker not found" });
    return;
  }

  req.log.info({ markerId: params.data.id }, "Marker archived");
  await recordAudit("marker_archived", (res.locals.adminUser as AdminUser).id, marker.ownerUserId, { markerId: marker.id, title: marker.title });
  res.sendStatus(204);
});

export default router;

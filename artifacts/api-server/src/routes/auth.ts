import { Router, type IRouter } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db, usersTable, markersTable } from "@workspace/db";
import {
  AdminLoginBody,
  GuestLoginBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Single source of truth for the treasure-code countdown duration.
// The timer is started ONLY by the first guest who enters a valid code
// (see guest-login below) — never by admin creation, never automatically.
const CODE_TTL_MS = 60 * 60 * 1000;

router.post("/auth/admin-login", async (req, res): Promise<void> => {
  const parsed = AdminLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { username, password } = parsed.data;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.role, "admin"));

  if (!user || (user.name !== username && user.email !== username)) {
    res.status(401).json({ error: "Nieprawidłowe dane administratora." });
    return;
  }

  if (user.passwordHash !== password) {
    res.status(401).json({ error: "Nieprawidłowe dane administratora." });
    return;
  }

  req.log.info({ userId: user.id }, "Admin logged in");
  res.json({ id: user.id, name: user.name, role: user.role });
});

router.post("/auth/guest-login", async (req, res): Promise<void> => {
  const parsed = GuestLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { code } = parsed.data;
  const upperCode = code.toUpperCase();

  const [marker] = await db
    .select()
    .from(markersTable)
    .where(eq(markersTable.code, upperCode));

  if (!marker) {
    res.status(401).json({ error: "Ten kod jest nieprawidłowy." });
    return;
  }

  // Block reads of an already-expired code. Markers with expiresAt === null
  // have NOT been activated yet — those are still redeemable.
  if (marker.expiresAt && new Date() > new Date(marker.expiresAt)) {
    res.status(401).json({ error: "Ten skarb już wygasł i nie można go odkryć!" });
    return;
  }

  // ── Atomic first-discovery activation ──
  // If the marker hasn't been activated yet, try to set expiresAt = NOW + 60min,
  // but ONLY if it is still null (first-writer-wins). Concurrent requests that
  // lose the race will see 0 rows updated and simply re-read the winning value.
  let activeExpiresAt = marker.expiresAt;
  if (!activeExpiresAt) {
    const newExpiresAt = new Date(Date.now() + CODE_TTL_MS);
    const [activated] = await db
      .update(markersTable)
      .set({ expiresAt: newExpiresAt })
      .where(and(eq(markersTable.id, marker.id), isNull(markersTable.expiresAt)))
      .returning();
    if (activated?.expiresAt) {
      activeExpiresAt = activated.expiresAt;
      req.log.info({ markerId: marker.id, expiresAt: activeExpiresAt }, "Code timer activated by first guest");
    } else {
      // Lost the race: another request just activated it. Re-read the winning value.
      const [fresh] = await db.select().from(markersTable).where(eq(markersTable.id, marker.id));
      if (!fresh?.expiresAt) {
        // Should never happen — row exists (we just selected it) and someone activated it.
        req.log.error({ markerId: marker.id }, "Failed to resolve marker timer after race");
        res.status(500).json({ error: "Nie udało się ustalić czasu wygaśnięcia." });
        return;
      }
      activeExpiresAt = fresh.expiresAt;
    }
  }

  req.log.info({ markerId: marker.id }, "Guest logged in with code");
  res.json({
    markerId: marker.id,
    code: marker.code,
    markerTitle: marker.title,
    markerDescription: marker.description,
    imageUrl: marker.imageUrl ?? null,
    lat: marker.lat,
    lng: marker.lng,
    // Single shared marker timer. After this moment the code is inactive.
    markerExpiresAt: activeExpiresAt!.toISOString(),
  });
});

export default router;

import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, usersTable, markersTable, guestDiscoveriesTable } from "@workspace/db";
import {
  AdminLoginBody,
  GuestLoginBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Image visibility window: 2 hours from the moment a guest discovers a treasure
const IMAGE_TTL_MS = 2 * 60 * 60 * 1000;

// Per-guest code countdown duration: 1 hour from the moment a guest enters a valid code.
// This guarantees the on-screen timer starts ONLY at discovery (not from page load or
// from the marker's seed time), and persists across page refreshes via guest_discoveries.
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

  const { code, guestToken } = parsed.data;
  const upperCode = code.toUpperCase();

  const [marker] = await db
    .select()
    .from(markersTable)
    .where(eq(markersTable.code, upperCode));

  if (!marker) {
    res.status(401).json({ error: "Ten kod jest nieprawidłowy." });
    return;
  }

  if (new Date() > new Date(marker.expiresAt)) {
    res.status(401).json({ error: "Ten skarb już wygasł i nie można go odkryć!" });
    return;
  }

  // Per-user discovery tracking: get-or-create a discovery row for this (marker, guestToken).
  // The discoveredAt timestamp is set ONCE on first discovery and never updated, so the
  // 2-hour image visibility window survives page refreshes and re-logins.
  let [discovery] = await db
    .select()
    .from(guestDiscoveriesTable)
    .where(
      and(
        eq(guestDiscoveriesTable.markerId, marker.id),
        eq(guestDiscoveriesTable.guestToken, guestToken)
      )
    );

  if (!discovery) {
    [discovery] = await db
      .insert(guestDiscoveriesTable)
      .values({ markerId: marker.id, guestToken })
      .returning();
    req.log.info({ markerId: marker.id, guestToken }, "New guest discovery recorded");
  }

  // Compute server-authoritative expiration. Image is hidden after 2h.
  const discoveredAt = new Date(discovery.discoveredAt);
  const imageExpiresAt = new Date(discoveredAt.getTime() + IMAGE_TTL_MS);
  const imageExpired = new Date() > imageExpiresAt;

  req.log.info({ markerId: marker.id }, "Guest logged in with code");
  res.json({
    markerId: marker.id,
    code: marker.code,
    markerTitle: marker.title,
    markerDescription: marker.description,
    imageUrl: imageExpired ? null : (marker.imageUrl ?? null),
    lat: marker.lat,
    lng: marker.lng,
    discoveredAt: discoveredAt.toISOString(),
    imageExpiresAt: imageExpiresAt.toISOString(),
    imageExpired,
    // Per-guest code expiration: timer starts at the moment THIS guest discovered the
    // treasure and runs for CODE_TTL_MS. Because discoveredAt is stable per-user (stored
    // in guest_discoveries), the timer persists across reloads and cannot restart.
    markerExpiresAt: new Date(discoveredAt.getTime() + CODE_TTL_MS).toISOString(),
  });
});

export default router;

import { Router, type IRouter } from "express";
import { createHash, randomBytes } from "node:crypto";
import { eq, and, isNull, gt, or, inArray } from "drizzle-orm";
import { db, accountInvitesTable, auditLogsTable, usersTable, markersTable } from "@workspace/db";
import {
  AdminLoginBody,
  GuestLoginBody,
} from "@workspace/api-zod";
import {
  clearAdminSession,
  getAuthenticatedAdmin,
  setAdminSession,
} from "../lib/admin-session";
import { hashPassword, verifyPassword } from "../lib/password";
import { recordAudit } from "../lib/audit";
import { hasAnalyticsAccess } from "../lib/analytics-core.mjs";

const router: IRouter = Router();

// Single source of truth for the treasure-code countdown duration.
// The timer is started ONLY by the first guest who enters a valid code
// (see guest-login below) — never by admin creation, never automatically.
const CODE_TTL_MS = 60 * 60 * 1000;
const INVITE_PASSWORD_MIN_LENGTH = 8;
const loginAttempts = new Map<string, { failures: number; windowStartedAt: number; blockedUntil: number }>();
const dummyHash = hashPassword(randomBytes(32).toString("hex"));
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const previewReadOnly = process.env.PYSNE_PREVIEW_READ_ONLY === "true";

function loginKey(ip: string | undefined, username: string): string {
  return `${ip ?? "unknown"}:${username.toLowerCase()}`;
}

function isLoginBlocked(key: string, now: number): boolean {
  const attempt = loginAttempts.get(key);
  if (!attempt) return false;
  if (attempt.blockedUntil > now) return true;
  if (now - attempt.windowStartedAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  return false;
}

function noteLoginFailure(key: string, now: number): void {
  if (loginAttempts.size > 5000) {
    for (const [savedKey, value] of loginAttempts) if (now - value.windowStartedAt > LOGIN_WINDOW_MS) loginAttempts.delete(savedKey);
  }
  const current = loginAttempts.get(key);
  const next = !current || now - current.windowStartedAt > LOGIN_WINDOW_MS
    ? { failures: 1, windowStartedAt: now, blockedUntil: 0 }
    : { ...current, failures: current.failures + 1 };
  if (next.failures >= 5) next.blockedUntil = now + LOGIN_BLOCK_MS;
  loginAttempts.set(key, next);
}

router.post("/auth/admin-login", async (req, res): Promise<void> => {
  const parsed = AdminLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { username, password } = parsed.data;
  const now = Date.now();
  const attemptKey = loginKey(req.ip, username);
  if (isLoginBlocked(attemptKey, now)) {
    res.setHeader("Retry-After", String(LOGIN_BLOCK_MS / 1000));
    res.status(429).json({ error: "Zbyt wiele prób logowania. Spróbuj ponownie za 15 minut." });
    return;
  }

  if (username.length > 254 || password.length > 1024) {
    res.status(401).json({ error: "Nieprawidłowe dane administratora." });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(and(
      inArray(usersTable.role, ["admin", "moderator", "master_admin"]),
      or(eq(usersTable.name, username), eq(usersTable.slug, username), eq(usersTable.email, username)),
    ));

  if (!user) {
    await verifyPassword(password, await dummyHash);
    noteLoginFailure(attemptKey, now);
    res.status(401).json({ error: "Nieprawidłowe dane administratora." });
    return;
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    noteLoginFailure(attemptKey, now);
    res.status(401).json({ error: "Nieprawidłowe dane administratora." });
    return;
  }

  loginAttempts.delete(attemptKey);

  req.log.info({ userId: user.id }, "Admin logged in");
  if (!previewReadOnly) {
    await recordAudit("admin_login", user.id, user.id, {});
  }
  res.setHeader("Cache-Control", "no-store");
  setAdminSession(res, user.id);
  res.json({ id: user.id, name: user.name, role: user.role, slug: user.slug, pinBalance: user.pinBalance, firstPurchaseBonusGranted: user.firstPurchaseBonusGranted, canAccessAnalytics: hasAnalyticsAccess(user) });
});

router.get("/auth/maps/:slug", async (req, res): Promise<void> => {
  const slug = typeof req.params.slug === "string" ? req.params.slug.toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(slug)) {
    res.status(404).json({ error: "Nie znaleziono tej mapy." });
    return;
  }
  const [map] = await db.select({ name: usersTable.name, slug: usersTable.slug })
    .from(usersTable).where(and(eq(usersTable.slug, slug), eq(usersTable.role, "admin"))).limit(1);
  if (!map) {
    res.status(404).json({ error: "Nie znaleziono tej mapy." });
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(map);
});

router.post("/auth/activate-account", async (req, res): Promise<void> => {
  const { token, password } = req.body ?? {};
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(token) ||
      typeof password !== "string" || password.length < INVITE_PASSWORD_MIN_LENGTH || password.length > 128) {
    res.status(400).json({ error: "Link zaproszenia lub hasło są nieprawidłowe." });
    return;
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = new Date();
  const user = await db.transaction(async (tx) => {
    const [claimed] = await tx.update(accountInvitesTable).set({ usedAt: now })
      .where(and(eq(accountInvitesTable.tokenHash, tokenHash), isNull(accountInvitesTable.usedAt), gt(accountInvitesTable.expiresAt, now)))
      .returning({ userId: accountInvitesTable.userId });
    if (!claimed) return null;
    const [activated] = await tx.update(usersTable).set({ passwordHash: await hashPassword(password) })
      .where(eq(usersTable.id, claimed.userId))
      .returning({ id: usersTable.id, name: usersTable.name, role: usersTable.role, slug: usersTable.slug, pinBalance: usersTable.pinBalance });
    if (!activated) throw new Error("Invite points to a missing account");
    await tx.insert(auditLogsTable).values({
      actorUserId: activated.id, tenantUserId: activated.id, eventType: "account_activated", details: {},
    });
    return activated;
  });
  if (!user) {
    res.status(404).json({ error: "Link wygasł albo został już wykorzystany. Poproś opiekuna konta o nowe zaproszenie." });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  setAdminSession(res, user.id);
  res.status(200).json(user);
});

router.get("/auth/session", async (req, res): Promise<void> => {
  const user = await getAuthenticatedAdmin(req);
  res.setHeader("Cache-Control", "no-store");
  if (!user) {
    clearAdminSession(res);
    res.status(401).json({ error: "Sesja administratora wygasła." });
    return;
  }
  res.json({ ...user, canAccessAnalytics: hasAnalyticsAccess(user) });
});

router.post("/auth/logout", (_req, res): void => {
  clearAdminSession(res);
  res.sendStatus(204);
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
    .where(and(eq(markersTable.code, upperCode), isNull(markersTable.archivedAt)));

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
  // If the marker hasn't been activated yet, try to set both `activatedAt` (= now)
  // and `expiresAt` (= now + 60min), but ONLY if expiresAt is still null
  // (first-writer-wins). Concurrent requests that lose the race re-read the winning
  // value. activatedAt is the source of truth for "Activation date" + discoveries log.
  let activeExpiresAt = marker.expiresAt;
  if (!activeExpiresAt) {
    const activatedAt = new Date();
    const newExpiresAt = new Date(activatedAt.getTime() + CODE_TTL_MS);
    const [activated] = await db
      .update(markersTable)
      .set({ expiresAt: newExpiresAt, activatedAt })
      .where(and(eq(markersTable.id, marker.id), isNull(markersTable.expiresAt)))
      .returning();
    if (activated?.expiresAt) {
      activeExpiresAt = activated.expiresAt;
      req.log.info({ markerId: marker.id, expiresAt: activeExpiresAt }, "Code timer activated by first guest");
      await recordAudit("treasure_activated", null, marker.ownerUserId, { markerId: marker.id });
    } else {
      const [fresh] = await db.select().from(markersTable).where(eq(markersTable.id, marker.id));
      if (!fresh?.expiresAt) {
        req.log.error({ markerId: marker.id }, "Failed to resolve marker timer after race");
        res.status(500).json({ error: "Nie udało się ustalić czasu wygaśnięcia." });
        return;
      }
      activeExpiresAt = fresh.expiresAt;
    }
  }

  req.log.info({ markerId: marker.id }, "Guest logged in with code");
  await recordAudit("guest_code_entered", null, marker.ownerUserId, { markerId: marker.id });
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

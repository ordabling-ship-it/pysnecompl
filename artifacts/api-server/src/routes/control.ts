import { Router, type IRouter, type Request } from "express";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db, accountInvitesTable, auditLogsTable, markersTable, pinTopupsTable, redemptionsTable, usersTable } from "@workspace/db";
import { getRoleCapabilities, PIN_PACKAGES } from "@workspace/api-zod";
import { hashPassword } from "../lib/password";
import { requireRole, type AdminUser } from "../lib/admin-session";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();
const MANAGER_ROLES = ["master_admin", "moderator"];
const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newInvite() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInviteToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) };
}

function inviteUrl(req: Request, token: string): string {
  return `${req.protocol}://${req.get("host")}/activate?token=${encodeURIComponent(token)}`;
}

function mayManageTarget(actor: AdminUser, target: { role: string; parentUserId: number | null }): boolean {
  if (actor.role === "master_admin") return target.role === "admin" || target.role === "moderator";
  return actor.role === "moderator" && target.role === "admin" && target.parentUserId === actor.id;
}

router.get("/control/users", requireRole(...MANAGER_ROLES), async (_req, res): Promise<void> => {
  const actor = res.locals.adminUser as AdminUser;
  const users = await db.select({
    id: usersTable.id, name: usersTable.name, slug: usersTable.slug,
    role: usersTable.role, parentUserId: usersTable.parentUserId,
    pinBalance: usersTable.pinBalance, createdAt: usersTable.createdAt,
  }).from(usersTable).where(
    actor.role === "master_admin"
      ? undefined
      : or(eq(usersTable.id, actor.id), eq(usersTable.parentUserId, actor.id)),
  ).orderBy(usersTable.createdAt);

  const rows = await Promise.all(users.map(async (user) => {
    const [activity] = await db.select({
      maps: sql<number>`count(distinct ${markersTable.id})::int`,
      activations: sql<number>`count(distinct ${markersTable.id}) filter (where ${markersTable.activatedAt} IS NOT NULL)::int`,
      redemptions: sql<number>`count(distinct ${redemptionsTable.id})::int`,
    }).from(markersTable)
      .leftJoin(redemptionsTable, eq(redemptionsTable.markerId, markersTable.id))
      .where(eq(markersTable.ownerUserId, user.id));
    return { ...user, createdAt: user.createdAt.toISOString(), totalPins: activity?.maps ?? 0, discoveries: activity?.activations ?? 0, redemptions: activity?.redemptions ?? 0 };
  }));
  res.setHeader("Cache-Control", "no-store");
  res.json(rows);
});

router.post("/control/users", requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const actor = res.locals.adminUser as AdminUser;
  const { username, role } = req.body ?? {};
  if (typeof username !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}$/.test(username)) {
    res.status(400).json({ error: "Login musi mieć 3–32 znaki: litery, cyfry, myślnik lub podkreślenie." });
    return;
  }
  const allowedRoles = getRoleCapabilities(actor.role).canCreateModerators ? ["admin", "moderator"] : ["admin"];
  if (typeof role !== "string" || !allowedRoles.includes(role)) {
    res.status(403).json({ error: "Nie możesz utworzyć konta z wybraną rolą." });
    return;
  }
  const slug = username.toLowerCase();
  const [existing] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(or(eq(usersTable.slug, slug), ilike(usersTable.name, username))).limit(1);
  if (existing) {
    res.status(409).json({ error: "Ten login jest już zajęty." });
    return;
  }
  const { token, tokenHash, expiresAt } = newInvite();
  const unclaimedPassword = randomBytes(48).toString("hex");
  const user = await db.transaction(async (tx) => {
    const [created] = await tx.insert(usersTable).values({
      name: username, slug, email: `${slug}@accounts.pysne.invalid`,
      passwordHash: await hashPassword(unclaimedPassword), role, parentUserId: actor.id, pinBalance: 10,
    }).returning({ id: usersTable.id, name: usersTable.name, slug: usersTable.slug, role: usersTable.role, pinBalance: usersTable.pinBalance });
    await tx.insert(accountInvitesTable).values({ userId: created.id, createdByUserId: actor.id, tokenHash, expiresAt });
    return created;
  });
  req.log.info({ userId: user.id, actorId: actor.id, role }, "Managed account created");
  await recordAudit("account_created", actor.id, user.id, { username: user.name, role: user.role, slug: user.slug });
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({ ...user, inviteUrl: inviteUrl(req, token), inviteExpiresAt: expiresAt.toISOString() });
});

router.post("/control/users/:userId/invite", requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const actor = res.locals.adminUser as AdminUser;
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    res.status(400).json({ error: "Nieprawidłowe konto." });
    return;
  }
  const [target] = await db.select({ id: usersTable.id, role: usersTable.role, parentUserId: usersTable.parentUserId })
    .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!target || !mayManageTarget(actor, target)) {
    res.status(404).json({ error: "Nie znaleziono konta do zaproszenia." });
    return;
  }
  const { token, tokenHash, expiresAt } = newInvite();
  await db.transaction(async (tx) => {
    await tx.update(accountInvitesTable).set({ usedAt: new Date() })
      .where(and(eq(accountInvitesTable.userId, target.id), isNull(accountInvitesTable.usedAt)));
    await tx.update(usersTable).set({ passwordHash: await hashPassword(randomBytes(48).toString("hex")) })
      .where(eq(usersTable.id, target.id));
    await tx.insert(accountInvitesTable).values({ userId: target.id, createdByUserId: actor.id, tokenHash, expiresAt });
  });
  await recordAudit("account_invite_issued", actor.id, target.id, { expiresAt: expiresAt.toISOString() });
  res.setHeader("Cache-Control", "no-store");
  res.json({ inviteUrl: inviteUrl(req, token), inviteExpiresAt: expiresAt.toISOString() });
});

router.patch("/control/users/:userId/password", requireRole("master_admin"), async (req, res): Promise<void> => {
  const actor = res.locals.adminUser as AdminUser;
  const userId = Number(req.params.userId);
  const { password } = req.body ?? {};
  if (!Number.isSafeInteger(userId) || userId < 1) {
    res.status(400).json({ error: "Nieprawidłowe konto." });
    return;
  }
  if (typeof password !== "string" || password.length < 15 || password.length > 128) {
    res.status(400).json({ error: "Hasło musi mieć od 15 do 128 znaków." });
    return;
  }
  const [target] = await db.select({ id: usersTable.id, name: usersTable.name, role: usersTable.role })
    .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!target || !["admin", "moderator"].includes(target.role)) {
    res.status(404).json({ error: "Nie znaleziono konta do zmiany hasła." });
    return;
  }

  await db.update(usersTable).set({ passwordHash: await hashPassword(password) }).where(eq(usersTable.id, target.id));
  req.log.info({ userId: target.id, actorId: actor.id }, "Managed account password reset");
  await recordAudit("account_password_reset", actor.id, target.id, { username: target.name });
  res.setHeader("Cache-Control", "no-store");
  res.sendStatus(204);
});

router.get("/control/overview", requireRole(...MANAGER_ROLES), async (_req, res): Promise<void> => {
  const [counts] = await db.select({
    accounts: sql<number>`count(distinct ${usersTable.id})::int`,
    admins: sql<number>`count(distinct ${usersTable.id}) filter (where ${usersTable.role} = 'admin')::int`,
    moderators: sql<number>`count(distinct ${usersTable.id}) filter (where ${usersTable.role} = 'moderator')::int`,
    markers: sql<number>`count(distinct ${markersTable.id})::int`,
  }).from(usersTable).leftJoin(markersTable, eq(markersTable.ownerUserId, usersTable.id));
  const [usage] = await db.select({
    activatedMarkers: sql<number>`count(*) filter (where ${markersTable.activatedAt} IS NOT NULL)::int`,
    activeMarkers: sql<number>`count(*) filter (where ${markersTable.archivedAt} IS NULL AND (${markersTable.expiresAt} IS NULL OR ${markersTable.expiresAt} > now()))::int`,
    expiredMarkers: sql<number>`count(*) filter (where ${markersTable.archivedAt} IS NULL AND ${markersTable.expiresAt} IS NOT NULL AND ${markersTable.expiresAt} <= now())::int`,
  }).from(markersTable);
  const [redemptions] = await db.select({ totalRedemptions: sql<number>`count(*)::int` }).from(redemptionsTable);
  const creatorUsage = await db.select({
    id: usersTable.id, name: usersTable.name, slug: usersTable.slug, pinBalance: usersTable.pinBalance,
    markers: sql<number>`count(distinct ${markersTable.id})::int`,
    activations: sql<number>`count(distinct ${markersTable.id}) filter (where ${markersTable.activatedAt} IS NOT NULL)::int`,
    activeMarkers: sql<number>`count(distinct ${markersTable.id}) filter (where ${markersTable.archivedAt} IS NULL AND (${markersTable.expiresAt} IS NULL OR ${markersTable.expiresAt} > now()))::int`,
    redemptions: sql<number>`count(distinct ${redemptionsTable.id})::int`,
  }).from(usersTable)
    .leftJoin(markersTable, eq(markersTable.ownerUserId, usersTable.id))
    .leftJoin(redemptionsTable, eq(redemptionsTable.markerId, markersTable.id))
    .where(eq(usersTable.role, "admin"))
    .groupBy(usersTable.id)
    .orderBy(usersTable.name);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...counts, ...usage, ...redemptions, creatorUsage, pinTopupsRequireManualConfirmation: true });
});

router.post("/control/users/:userId/pin-topups", requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const actor = res.locals.adminUser as AdminUser;
  const userId = Number(req.params.userId);
  const packageId = req.body?.packageId;
  const paymentReference = typeof req.body?.paymentReference === "string" ? req.body.paymentReference.trim().slice(0, 160) : "";
  const pack = PIN_PACKAGES.find((item) => item.id === packageId);
  if (!Number.isSafeInteger(userId) || userId < 1 || !pack || paymentReference.length < 3) {
    res.status(400).json({ error: "Wybierz pakiet i wpisz identyfikator lub krótki opis potwierdzonej wpłaty." });
    return;
  }
  const [target] = await db.select({ id: usersTable.id, role: usersTable.role, parentUserId: usersTable.parentUserId })
    .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!target || target.role !== "admin" || (actor.role === "moderator" && target.parentUserId !== actor.id)) {
    res.status(404).json({ error: "Nie znaleziono Kreatora w zakresie tego konta." });
    return;
  }
  const reference = paymentReference.toUpperCase();
  const result = await db.transaction(async (tx) => {
    const [topup] = await tx.insert(pinTopupsTable).values({
      userId: target.id, grantedByUserId: actor.id, packageId: pack.id,
      pins: pack.pins, pricePln: pack.pricePln, paymentReference: reference,
    }).onConflictDoNothing({ target: pinTopupsTable.paymentReference }).returning({ id: pinTopupsTable.id });
    if (!topup) return null;
    const [updated] = await tx.update(usersTable)
      .set({ pinBalance: sql`${usersTable.pinBalance} + ${pack.pins}` })
      .where(eq(usersTable.id, target.id))
      .returning({ pinBalance: usersTable.pinBalance });
    await tx.insert(auditLogsTable).values({
      actorUserId: actor.id, tenantUserId: target.id, eventType: "pin_package_granted",
      details: { packageId: pack.id, pins: pack.pins, pricePln: pack.pricePln, paymentReference: reference },
    });
    return { topupId: topup.id, pinBalance: updated.pinBalance };
  });
  if (!result) {
    res.status(409).json({ error: "Ta wpłata została już rozliczona." });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...result, addedPins: pack.pins });
});

router.get("/control/activity", requireRole("master_admin", "moderator"), async (_req, res): Promise<void> => {
  const actor = res.locals.adminUser as AdminUser;
  const scopeIds = actor.role === "master_admin" ? [] : [actor.id, ...(await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.parentUserId, actor.id))).map((user) => user.id)];
  const events = await db.select({
    id: auditLogsTable.id, eventType: auditLogsTable.eventType,
    details: auditLogsTable.details, createdAt: auditLogsTable.createdAt,
    actorName: usersTable.name, tenantUserId: auditLogsTable.tenantUserId,
  }).from(auditLogsTable)
    .leftJoin(usersTable, eq(auditLogsTable.actorUserId, usersTable.id))
    .where(actor.role === "master_admin" ? undefined : or(eq(auditLogsTable.actorUserId, actor.id), inArray(auditLogsTable.tenantUserId, scopeIds)))
    .orderBy(sql`${auditLogsTable.createdAt} DESC`).limit(100);
  res.setHeader("Cache-Control", "no-store");
  res.json(events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })));
});

export default router;

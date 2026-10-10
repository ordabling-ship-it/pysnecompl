import { Router, type IRouter } from "express";
import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db, auditLogsTable, markersTable, redemptionsTable, usersTable } from "@workspace/db";
import { hashPassword } from "../lib/password";
import { requireRole, type AdminUser } from "../lib/admin-session";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();
const MANAGER_ROLES = ["master_admin", "moderator"];

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
  const { username, password, role } = req.body ?? {};
  if (typeof username !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}$/.test(username)) {
    res.status(400).json({ error: "Login musi mieć 3–32 znaki: litery, cyfry, myślnik lub podkreślenie." });
    return;
  }
  if (typeof password !== "string" || password.length < 15 || password.length > 1024) {
    res.status(400).json({ error: "Hasło musi mieć co najmniej 15 znaków." });
    return;
  }
  const allowedRoles = actor.role === "master_admin" ? ["admin", "moderator"] : ["admin"];
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
  const [user] = await db.insert(usersTable).values({
    name: username, slug, email: `${slug}@accounts.pysne.invalid`,
    passwordHash: await hashPassword(password), role, parentUserId: actor.id, pinBalance: 10,
  }).returning({ id: usersTable.id, name: usersTable.name, slug: usersTable.slug, role: usersTable.role, pinBalance: usersTable.pinBalance });
  req.log.info({ userId: user.id, actorId: actor.id, role }, "Managed account created");
  await recordAudit("account_created", actor.id, user.id, { username: user.name, role: user.role, slug: user.slug });
  res.status(201).json(user);
});

router.get("/control/overview", requireRole("master_admin"), async (_req, res): Promise<void> => {
  const [counts] = await db.select({
    accounts: sql<number>`count(distinct ${usersTable.id})::int`,
    admins: sql<number>`count(distinct ${usersTable.id}) filter (where ${usersTable.role} = 'admin')::int`,
    moderators: sql<number>`count(distinct ${usersTable.id}) filter (where ${usersTable.role} = 'moderator')::int`,
    markers: sql<number>`count(distinct ${markersTable.id})::int`,
  }).from(usersTable).leftJoin(markersTable, eq(markersTable.ownerUserId, usersTable.id));
  res.setHeader("Cache-Control", "no-store");
  res.json(counts);
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

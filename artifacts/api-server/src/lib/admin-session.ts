import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { logger } from "./logger";

const COOKIE_NAME = "pysne_admin_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const configuredSecret = process.env.SESSION_SECRET;
const signingSecret = configuredSecret ?? randomBytes(32).toString("base64url");
if (!configuredSecret && process.env.NODE_ENV === "production") {
  logger.warn("SESSION_SECRET is missing; admin sessions will expire when the server restarts.");
}
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

type SessionPayload = {
  sub: number;
  iat: number;
  exp: number;
};

export type AdminUser = {
  id: number;
  name: string;
  role: string;
  slug: string;
  parentUserId: number | null;
  pinBalance: number;
  firstPurchaseBonusGranted: boolean;
};

const ADMIN_ROLES = ["admin", "moderator", "master_admin"] as const;

function sign(value: string): Buffer {
  return createHmac("sha256", signingSecret).update(value).digest();
}

function createToken(userId: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: userId,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encodedPayload).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

function readPayload(token: unknown): SessionPayload | null {
  if (typeof token !== "string" || token.length > 2048) return null;
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) return null;

  let suppliedSignature: Buffer;
  let payload: SessionPayload;
  try {
    suppliedSignature = Buffer.from(encodedSignature, "base64url");
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }

  const expectedSignature = sign(encodedPayload);
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(payload.sub) || payload.sub < 1 ||
    !Number.isSafeInteger(payload.iat) || payload.iat > now + 60 ||
    !Number.isSafeInteger(payload.exp) || payload.exp <= now ||
    payload.exp - payload.iat > SESSION_TTL_SECONDS
  ) {
    return null;
  }

  return payload;
}

export function setAdminSession(res: Response, userId: number): void {
  res.cookie(COOKIE_NAME, createToken(userId), {
    ...cookieOptions,
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

export function clearAdminSession(res: Response): void {
  res.clearCookie(COOKIE_NAME, cookieOptions);
}

export async function getAuthenticatedAdmin(req: Request): Promise<AdminUser | null> {
  const payload = readPayload(req.cookies?.[COOKIE_NAME]);
  if (!payload) return null;

  const [user] = await db
    .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role, slug: usersTable.slug, parentUserId: usersTable.parentUserId, pinBalance: usersTable.pinBalance, firstPurchaseBonusGranted: usersTable.firstPurchaseBonusGranted })
    .from(usersTable)
    .where(and(eq(usersTable.id, payload.sub), inArray(usersTable.role, [...ADMIN_ROLES])));

  return user ?? null;
}

function hasSameOrigin(req: Request): boolean {
  const origin = req.get("origin");
  if (!origin) return process.env.NODE_ENV !== "production";
  const host = req.get("host");
  if (!host) return false;
  return origin === `${req.protocol}://${host}`;
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");

  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !hasSameOrigin(req)) {
    res.status(403).json({ error: "Żądanie pochodzi z niedozwolonego źródła." });
    return;
  }

  const user = await getAuthenticatedAdmin(req);
  if (!user) {
    clearAdminSession(res);
    res.status(401).json({ error: "Wymagane jest logowanie administratora." });
    return;
  }

  res.locals.adminUser = user;

  next();
}

export function requireRole(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await requireAdmin(req, res, () => {
      const user = res.locals.adminUser as AdminUser | undefined;
      if (!user || !roles.includes(user.role)) {
        res.status(403).json({ error: "Brak uprawnień do tej funkcji." });
        return;
      }
      next();
    });
  };
}

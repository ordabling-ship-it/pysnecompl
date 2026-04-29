import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  AdminLoginBody,
  GuestLoginBody,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

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

  const { markersTable } = await import("@workspace/db");
  const { eq, gt } = await import("drizzle-orm");

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

  req.log.info({ markerId: marker.id }, "Guest logged in with code");
  res.json({
    markerId: marker.id,
    code: marker.code,
    markerTitle: marker.title,
    markerDescription: marker.description,
    imageUrl: marker.imageUrl ?? null,
    lat: marker.lat,
    lng: marker.lng,
  });
});

export default router;

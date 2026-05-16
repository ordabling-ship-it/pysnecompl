import { pgTable, serial, text, doublePrecision, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const markersTable = pgTable("markers", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  code: text("code").notNull().unique(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  imageUrl: text("image_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Null = countdown has not started yet (admin created the marker but no guest
  // has entered the code). Set to NOW + 60min atomically on the first successful
  // guest-login. NEVER updated after that.
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export const insertMarkerSchema = createInsertSchema(markersTable).omit({
  id: true,
  createdAt: true,
});

export type InsertMarker = z.infer<typeof insertMarkerSchema>;
export type Marker = typeof markersTable.$inferSelect;

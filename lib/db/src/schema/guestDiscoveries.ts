import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const guestDiscoveriesTable = pgTable(
  "guest_discoveries",
  {
    id: serial("id").primaryKey(),
    markerId: integer("marker_id").notNull(),
    guestToken: text("guest_token").notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    markerGuestUnique: uniqueIndex("guest_discoveries_marker_token_uniq").on(
      table.markerId,
      table.guestToken
    ),
  })
);

export type GuestDiscovery = typeof guestDiscoveriesTable.$inferSelect;

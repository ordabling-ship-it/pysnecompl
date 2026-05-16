import { pgTable, integer, timestamp } from "drizzle-orm/pg-core";

// Singleton settings row (id is always 1). Holds global, app-wide values that
// don't naturally belong on a domain table — currently just the timestamp of
// the most recent "discoveries counter" reset performed by the admin.
export const settingsTable = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  discoveriesResetAt: timestamp("discoveries_reset_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Settings = typeof settingsTable.$inferSelect;

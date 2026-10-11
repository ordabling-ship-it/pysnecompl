import { pgTable, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const accountInvitesTable = pgTable("account_invites", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  createdByUserId: integer("created_by_user_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tokenHashUnique: uniqueIndex("account_invites_token_hash_unique").on(table.tokenHash),
  userIndex: index("account_invites_user_id_idx").on(table.userId),
}));

export type AccountInvite = typeof accountInvitesTable.$inferSelect;

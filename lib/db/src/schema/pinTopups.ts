import { pgTable, serial, integer, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const pinTopupsTable = pgTable("pin_topups", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  grantedByUserId: integer("granted_by_user_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  packageId: text("package_id").notNull(),
  pins: integer("pins").notNull(),
  pricePln: integer("price_pln").notNull(),
  paymentReference: text("payment_reference").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  paymentReferenceUnique: uniqueIndex("pin_topups_payment_reference_unique").on(table.paymentReference),
  userIndex: index("pin_topups_user_id_idx").on(table.userId),
}));

export type PinTopup = typeof pinTopupsTable.$inferSelect;

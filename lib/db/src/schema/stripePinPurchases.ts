import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const stripePinPurchasesTable = pgTable("stripe_pin_purchases", {
  id: serial("id").primaryKey(),
  creatorUserId: integer("creator_user_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  stripeSessionId: text("stripe_session_id").notNull(),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  packageId: text("package_id").notNull(),
  pins: integer("pins").notNull(),
  bonusPins: integer("bonus_pins").notNull().default(0),
  amountCents: integer("amount_cents").notNull(),
  refundAmountCents: integer("refund_amount_cents").notNull().default(0),
  currency: text("currency").notNull().default("pln"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("stripe_pin_purchases_session_unique").on(table.stripeSessionId),
  index("stripe_pin_purchases_creator_created_idx").on(table.creatorUserId, table.createdAt),
]);

export type StripePinPurchase = typeof stripePinPurchasesTable.$inferSelect;

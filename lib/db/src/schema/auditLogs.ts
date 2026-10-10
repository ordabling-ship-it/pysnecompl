import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  actorUserId: integer("actor_user_id"),
  tenantUserId: integer("tenant_user_id"),
  eventType: text("event_type").notNull(),
  details: jsonb("details").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AuditLog = typeof auditLogsTable.$inferSelect;

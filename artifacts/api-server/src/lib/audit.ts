import { db, auditLogsTable } from "@workspace/db";
import { logger } from "./logger";

export async function recordAudit(
  eventType: string,
  actorUserId: number | null,
  tenantUserId: number | null,
  details: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  try {
    await db.insert(auditLogsTable).values({ eventType, actorUserId, tenantUserId, details });
  } catch (error) {
    logger.error({ error, eventType }, "Audit event could not be stored");
  }
}

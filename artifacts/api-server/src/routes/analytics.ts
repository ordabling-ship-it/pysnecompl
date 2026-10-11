import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getAuthenticatedAdmin } from "../lib/admin-session";
import { analyticsAccessStatus, csvCell, percentChange } from "../lib/analytics-core.mjs";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const PAGE_SIZE_MAX = 100;
const EXPORT_MAX = 5000;
const PRIVATE_AUDIT_DETAIL_KEYS = "ARRAY['code','token','pin','stripePaymentIntentId','paymentIntentId','stripeSessionId','clientSecret','webhookSecret','apiKey','accessToken','refreshToken','authorization','cookie','session','sessionId','email','phone','address','password','ip']::text[]";
class AnalyticsInputError extends Error {}

type Filters = {
  from: Date;
  to: Date;
  userId: number | null;
  category: string | null;
  status: string | null;
  eventType: string | null;
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null;
};

function parseDate(value: unknown, fallback: Date, inclusiveEnd = false): Date {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string" || value.length > 40) throw new AnalyticsInputError("Nieprawidłowa data filtra.");
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly && inclusiveEnd ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(date.getTime())) throw new AnalyticsInputError("Nieprawidłowa data filtra.");
  if (dateOnly && inclusiveEnd) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function parseFilters(req: Request): Filters {
  const now = new Date();
  const defaultTo = now;
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const from = parseDate(req.query.from, defaultFrom);
  const to = parseDate(req.query.to, defaultTo, true);
  if (to <= from || to.getTime() - from.getTime() > 100 * 365 * 24 * 60 * 60 * 1000) {
    throw new AnalyticsInputError("Zakres dat jest nieprawidłowy albo zbyt długi.");
  }

  const rawUserId = req.query.userId;
  const userId = rawUserId == null || rawUserId === "" ? null : Number(rawUserId);
  if (userId !== null && (!Number.isSafeInteger(userId) || userId < 1)) throw new AnalyticsInputError("Nieprawidłowy filtr użytkownika.");
  if (req.query.category != null && (typeof req.query.category !== "string" || req.query.category.length > 50)) throw new AnalyticsInputError("Nieprawidłowa kategoria.");
  const category = typeof req.query.category === "string" ? req.query.category.trim() || null : null;
  if (req.query.status != null && !["pending", "paid", "failed", "expired", "refunded", "partially_refunded"].includes(String(req.query.status))) throw new AnalyticsInputError("Nieprawidłowy status płatności.");
  const status = typeof req.query.status === "string" ? req.query.status : null;
  if (req.query.eventType != null && (typeof req.query.eventType !== "string" || !/^[a-z0-9_-]{1,80}$/i.test(req.query.eventType))) throw new AnalyticsInputError("Nieprawidłowy rodzaj zdarzenia.");
  const eventType = typeof req.query.eventType === "string" ? req.query.eventType : null;

  const keys = ["minLat", "maxLat", "minLng", "maxLng"] as const;
  const values = keys.map((key) => req.query[key] == null || req.query[key] === "" ? null : Number(req.query[key]));
  let bbox: Filters["bbox"] = null;
  if (values.some((value) => value !== null)) {
    if (values.some((value) => value === null || !Number.isFinite(value))) throw new AnalyticsInputError("Podaj pełny, prawidłowy obszar mapy.");
    const [minLat, maxLat, minLng, maxLng] = values as number[];
    if (minLat < -90 || maxLat > 90 || minLat > maxLat || minLng < -180 || maxLng > 180 || minLng > maxLng) throw new AnalyticsInputError("Obszar mapy jest nieprawidłowy.");
    bbox = { minLat, maxLat, minLng, maxLng };
  }
  return { from, to, userId, category, status, eventType, bbox };
}

function filterError(res: Response, error: unknown): void {
  if (error instanceof AnalyticsInputError) {
    res.status(400).json({ error: error.message });
    return;
  }
  logger.error({ error }, "Analytics request failed");
  res.status(500).json({ error: "Nie udało się pobrać danych analitycznych." });
}

function pageParams(req: Request): { page: number; limit: number; offset: number } {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 25);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE_MAX) {
    throw new AnalyticsInputError("Nieprawidłowa strona lub rozmiar wyników (maksymalnie 100).");
  }
  return { page, limit, offset: (page - 1) * limit };
}

function whereParts(filters: Filters, column: string, params: unknown[], options: { dateColumn?: string; categoryColumn?: string; statusExpression?: string; bbox?: boolean } = {}): string[] {
  const conditions: string[] = [];
  const dateColumn = options.dateColumn ?? "created_at";
  params.push(filters.from); conditions.push(`${dateColumn} >= $${params.length}`);
  params.push(filters.to); conditions.push(`${dateColumn} < $${params.length}`);
  if (filters.userId != null) { params.push(filters.userId); conditions.push(`${column} = $${params.length}`); }
  if (filters.category && options.categoryColumn) {
    if (filters.category === "__none__") conditions.push(`${options.categoryColumn} IS NULL`);
    else { params.push(filters.category); conditions.push(`${options.categoryColumn} = $${params.length}`); }
  }
  if (filters.status && options.statusExpression) { params.push(filters.status); conditions.push(`${options.statusExpression} = $${params.length}`); }
  if (filters.eventType && options.statusExpression === "event_type") { params.push(filters.eventType); conditions.push(`event_type = $${params.length}`); }
  if (filters.bbox && options.bbox) {
    for (const [columnName, value, operator] of [
      ["lat", filters.bbox.minLat, ">="], ["lat", filters.bbox.maxLat, "<="],
      ["lng", filters.bbox.minLng, ">="], ["lng", filters.bbox.maxLng, "<="],
    ] as const) { params.push(value); conditions.push(`${columnName} ${operator} $${params.length}`); }
  }
  return conditions;
}

router.use(async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  const user = await getAuthenticatedAdmin(req);
  const accessStatus = analyticsAccessStatus(user);
  if (accessStatus === 401) { res.status(401).json({ error: "Zaloguj się, aby otworzyć analitykę." }); return; }
  if (accessStatus === 403) { res.status(403).json({ error: "Analityka jest dostępna tylko dla uprawnionych kont." }); return; }
  res.locals.adminUser = user;
  next();
});

router.get("/analytics/filters", async (_req, res): Promise<void> => {
  try {
    const [categories, eventTypes] = await Promise.all([
      pool.query("SELECT DISTINCT category FROM markers WHERE category IS NOT NULL AND category <> '' ORDER BY category LIMIT 200"),
      pool.query("SELECT DISTINCT event_type AS value FROM audit_logs ORDER BY event_type LIMIT 100"),
    ]);
    res.json({ categories: categories.rows.map((row) => row.category), eventTypes: eventTypes.rows.map((row) => row.value) });
  } catch (error) { filterError(res, error); }
});

router.get("/analytics/overview", async (req, res): Promise<void> => {
  let filters: Filters;
  try { filters = parseFilters(req); } catch (error) { filterError(res, error); return; }
  const duration = filters.to.getTime() - filters.from.getTime();
  const previousFrom = new Date(filters.from.getTime() - duration);
  const previousTo = filters.from;
  const userFilter = filters.userId ? " AND owner_user_id = $3" : "";
  const userFilterAudit = filters.userId ? " AND COALESCE(actor_user_id, tenant_user_id) = $3" : "";
  const bind = filters.userId ? [filters.from, filters.to, filters.userId] : [filters.from, filters.to];
  const previousBind = filters.userId ? [previousFrom, previousTo, filters.userId] : [previousFrom, previousTo];
  const [countsResult, periodResult, activeResult, dauResult, wauResult, mauResult, returningResult, inactiveResult, moneyResult, revenueResult, refundResult, comparisonResult, seriesResult, leadersResult, funnelResult, retentionResult, anomalyResult, weekdaysResult] = await Promise.all([
    pool.query(`SELECT (SELECT count(*)::int FROM users) AS users_total, (SELECT count(*)::int FROM markers) AS pins_total`),
    pool.query(`SELECT
      (SELECT count(*)::int FROM users WHERE created_at >= $1 AND created_at < $2${filters.userId ? " AND id = $3" : ""}) AS registrations,
      (SELECT count(*)::int FROM markers WHERE created_at >= $1 AND created_at < $2${userFilter}) AS pins_created`, bind),
    pool.query(`SELECT count(DISTINCT COALESCE(actor_user_id, tenant_user_id))::int AS value FROM audit_logs WHERE created_at >= $1 AND created_at < $2 AND COALESCE(actor_user_id, tenant_user_id) IS NOT NULL${userFilterAudit}`, bind),
    pool.query(`SELECT count(DISTINCT COALESCE(actor_user_id, tenant_user_id))::int AS value FROM audit_logs WHERE created_at >= date_trunc('day', now()) AND created_at < date_trunc('day', now()) + interval '1 day' AND COALESCE(actor_user_id, tenant_user_id) IS NOT NULL${filters.userId ? " AND COALESCE(actor_user_id, tenant_user_id) = $1" : ""}`, filters.userId ? [filters.userId] : []),
    pool.query(`SELECT count(DISTINCT COALESCE(actor_user_id, tenant_user_id))::int AS value FROM audit_logs WHERE created_at >= now() - interval '7 days' AND COALESCE(actor_user_id, tenant_user_id) IS NOT NULL${filters.userId ? " AND COALESCE(actor_user_id, tenant_user_id) = $1" : ""}`, filters.userId ? [filters.userId] : []),
    pool.query(`SELECT count(DISTINCT COALESCE(actor_user_id, tenant_user_id))::int AS value FROM audit_logs WHERE created_at >= now() - interval '30 days' AND COALESCE(actor_user_id, tenant_user_id) IS NOT NULL${filters.userId ? " AND COALESCE(actor_user_id, tenant_user_id) = $1" : ""}`, filters.userId ? [filters.userId] : []),
    (() => {
      const params: unknown[] = [filters.from, filters.to, filters.from];
      const userClause = filters.userId ? (params.push(filters.userId), ` AND COALESCE(a.actor_user_id,a.tenant_user_id)=$${params.length}`) : "";
      return pool.query(`SELECT count(DISTINCT COALESCE(a.actor_user_id,a.tenant_user_id))::int AS value FROM audit_logs a
        WHERE a.created_at >= $1 AND a.created_at < $2 AND COALESCE(a.actor_user_id,a.tenant_user_id) IS NOT NULL${userClause}
        AND EXISTS (SELECT 1 FROM audit_logs previous WHERE COALESCE(previous.actor_user_id,previous.tenant_user_id)=COALESCE(a.actor_user_id,a.tenant_user_id) AND previous.created_at < $3)`, params);
    })(),
    pool.query(`SELECT count(*)::int AS value FROM users u WHERE ($1::int IS NULL OR u.id=$1) AND NOT EXISTS
      (SELECT 1 FROM audit_logs a WHERE COALESCE(a.actor_user_id,a.tenant_user_id)=u.id AND a.created_at >= now()-interval '30 days')`, [filters.userId]),
    pool.query(`SELECT count(*)::int AS transactions
      FROM stripe_pin_purchases WHERE created_at >= $1 AND created_at < $2${filters.userId ? " AND creator_user_id = $3" : ""}`, bind),
    pool.query(`SELECT currency,count(*)::int AS paid_count,COALESCE(sum(amount_cents),0)::bigint AS gross_cents,round(avg(amount_cents))::bigint AS average_cents
      FROM stripe_pin_purchases WHERE status='paid' AND paid_at >= $1 AND paid_at < $2${filters.userId ? " AND creator_user_id=$3" : ""} GROUP BY currency ORDER BY currency`, bind),
    pool.query(`SELECT details->>'currency' AS currency,COALESCE(sum((details->>'refundDeltaCents')::bigint),0)::bigint AS refunded_cents
      FROM audit_logs WHERE event_type='pin_pack_refunded' AND created_at >= $1 AND created_at < $2${filters.userId ? " AND tenant_user_id=$3" : ""} GROUP BY 1 ORDER BY 1`, bind),
    Promise.all([
      pool.query(`SELECT count(*)::int AS value FROM users WHERE created_at >= $1 AND created_at < $2${filters.userId ? " AND id = $3" : ""}`, previousBind),
      pool.query(`SELECT count(*)::int AS value FROM markers WHERE created_at >= $1 AND created_at < $2${userFilter}`, previousBind),
      pool.query(`SELECT count(DISTINCT COALESCE(actor_user_id, tenant_user_id))::int AS value FROM audit_logs WHERE created_at >= $1 AND created_at < $2 AND COALESCE(actor_user_id, tenant_user_id) IS NOT NULL${userFilterAudit}`, previousBind),
      pool.query(`SELECT currency, count(*)::int AS count, COALESCE(sum(amount_cents),0)::bigint AS gross FROM stripe_pin_purchases WHERE status='paid' AND paid_at >= $1 AND paid_at < $2${filters.userId ? " AND creator_user_id = $3" : ""} GROUP BY currency ORDER BY currency`, previousBind),
      pool.query(`SELECT count(*)::int AS value FROM stripe_pin_purchases WHERE created_at >= $1 AND created_at < $2${filters.userId ? " AND creator_user_id=$3" : ""}`, previousBind),
    ]),
    (() => {
      const bucket = duration <= 366 * 86400000 ? "day" : "week";
      const step = bucket === "day" ? "1 day" : "1 week";
      return pool.query(`WITH buckets AS (SELECT generate_series(date_trunc('${bucket}', $1::timestamptz), date_trunc('${bucket}', $2::timestamptz - interval '1 millisecond'), interval '${step}') AS bucket)
        SELECT b.bucket, COALESCE(u.value,0)::int AS registrations, COALESCE(m.value,0)::int AS pins, COALESCE(a.value,0)::int AS active
        FROM buckets b
        LEFT JOIN LATERAL (SELECT count(*)::int AS value FROM users WHERE created_at >= b.bucket AND created_at < b.bucket + interval '${step}'${filters.userId ? " AND id = $3" : ""}) u ON true
        LEFT JOIN LATERAL (SELECT count(*)::int AS value FROM markers WHERE created_at >= b.bucket AND created_at < b.bucket + interval '${step}'${userFilter}) m ON true
        LEFT JOIN LATERAL (SELECT count(DISTINCT COALESCE(actor_user_id, tenant_user_id))::int AS value FROM audit_logs WHERE created_at >= b.bucket AND created_at < b.bucket + interval '${step}' AND COALESCE(actor_user_id, tenant_user_id) IS NOT NULL${filters.userId ? " AND COALESCE(actor_user_id, tenant_user_id) = $3" : ""}) a ON true
        ORDER BY b.bucket LIMIT 400`, bind);
    })(),
    pool.query(`SELECT u.id, u.name, u.role, count(DISTINCT a.id)::int AS events, count(DISTINCT m.id)::int AS pins
      FROM users u LEFT JOIN audit_logs a ON COALESCE(a.actor_user_id,a.tenant_user_id)=u.id AND a.created_at >= $1 AND a.created_at < $2
      LEFT JOIN markers m ON m.owner_user_id=u.id AND m.created_at >= $1 AND m.created_at < $2
      WHERE ($3::int IS NULL OR u.id=$3) GROUP BY u.id ORDER BY events DESC, pins DESC LIMIT 5`, [filters.from, filters.to, filters.userId]),
    pool.query(`WITH cohort AS (SELECT id, created_at FROM users WHERE created_at >= $1 AND created_at < $2${filters.userId ? " AND id = $3" : ""})
      SELECT count(*)::int AS registered,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM audit_logs a WHERE COALESCE(a.actor_user_id,a.tenant_user_id)=cohort.id AND a.created_at >= cohort.created_at))::int AS active,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM markers m WHERE m.owner_user_id=cohort.id AND m.created_at >= cohort.created_at))::int AS pinned,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM stripe_pin_purchases p WHERE p.creator_user_id=cohort.id AND p.status='paid' AND p.paid_at >= cohort.created_at))::int AS paid
      FROM cohort`, filters.userId ? [filters.from, filters.to, filters.userId] : [filters.from, filters.to]),
    pool.query(`WITH cohort AS (SELECT id, created_at FROM users WHERE created_at >= $1 AND created_at < $2${filters.userId ? " AND id = $3" : ""})
      SELECT count(*)::int AS registered,
      count(*) FILTER (WHERE created_at < now()-interval '1 day')::int AS day1_eligible,
      count(*) FILTER (WHERE created_at < now()-interval '1 day' AND EXISTS (SELECT 1 FROM audit_logs a WHERE COALESCE(a.actor_user_id,a.tenant_user_id)=cohort.id AND (a.created_at AT TIME ZONE 'UTC')::date=(cohort.created_at AT TIME ZONE 'UTC')::date + 1))::int AS day1,
      count(*) FILTER (WHERE created_at < now()-interval '7 days')::int AS day7_eligible,
      count(*) FILTER (WHERE created_at < now()-interval '7 days' AND EXISTS (SELECT 1 FROM audit_logs a WHERE COALESCE(a.actor_user_id,a.tenant_user_id)=cohort.id AND (a.created_at AT TIME ZONE 'UTC')::date=(cohort.created_at AT TIME ZONE 'UTC')::date + 7))::int AS day7,
      count(*) FILTER (WHERE created_at < now()-interval '30 days')::int AS day30_eligible,
      count(*) FILTER (WHERE created_at < now()-interval '30 days' AND EXISTS (SELECT 1 FROM audit_logs a WHERE COALESCE(a.actor_user_id,a.tenant_user_id)=cohort.id AND (a.created_at AT TIME ZONE 'UTC')::date=(cohort.created_at AT TIME ZONE 'UTC')::date + 30))::int AS day30
      FROM cohort`, filters.userId ? [filters.from, filters.to, filters.userId] : [filters.from, filters.to]),
    Promise.all([
      pool.query(`SELECT count(*)::int AS value FROM markers WHERE created_at >= now() - interval '7 days'`),
      pool.query(`SELECT count(*)::int AS value FROM markers WHERE created_at >= now() - interval '37 days' AND created_at < now() - interval '7 days'`),
      pool.query(`SELECT count(*)::int AS value FROM users WHERE created_at >= now() - interval '7 days'`),
      pool.query(`SELECT count(*)::int AS value FROM users WHERE created_at >= now() - interval '37 days' AND created_at < now() - interval '7 days'`),
      pool.query(`SELECT count(*)::int AS value FROM stripe_pin_purchases WHERE status IN ('failed','expired') AND created_at >= now() - interval '7 days'`),
      pool.query(`SELECT count(DISTINCT COALESCE(actor_user_id,tenant_user_id))::int AS value FROM audit_logs WHERE created_at >= now() - interval '7 days' AND COALESCE(actor_user_id,tenant_user_id) IS NOT NULL`),
      pool.query(`SELECT count(DISTINCT COALESCE(actor_user_id,tenant_user_id))::int AS value FROM audit_logs WHERE created_at >= now() - interval '37 days' AND created_at < now() - interval '7 days' AND COALESCE(actor_user_id,tenant_user_id) IS NOT NULL`),
    ]),
    pool.query(`SELECT extract(isodow from created_at)::int AS day, count(*)::int AS value FROM markers WHERE created_at >= $1 AND created_at < $2 GROUP BY day ORDER BY value DESC LIMIT 1`, [filters.from, filters.to]),
  ]);

  const counts = countsResult.rows[0] ?? { users_total: 0, pins_total: 0 };
  const period = periodResult.rows[0] ?? { registrations: 0, pins_created: 0 };
  const metrics = {
    usersTotal: Number(counts.users_total), registrations: Number(period.registrations), activeUsers: Number(activeResult.rows[0]?.value ?? 0),
    dau: Number(dauResult.rows[0]?.value ?? 0), wau: Number(wauResult.rows[0]?.value ?? 0), mau: Number(mauResult.rows[0]?.value ?? 0),
    returningUsers: Number(returningResult.rows[0]?.value ?? 0), inactiveUsers: Number(inactiveResult.rows[0]?.value ?? 0),
    pinsTotal: Number(counts.pins_total), pinsCreated: Number(period.pins_created),
    transactions: moneyResult.rows.reduce((sum, row) => sum + Number(row.transactions), 0),
    paidTransactions: revenueResult.rows.reduce((sum, row) => sum + Number(row.paid_count), 0),
    averageTransactionCentsByCurrency: revenueResult.rows.map((row) => {
      const prior = comparisonResult[3].rows.find((item) => item.currency === row.currency);
      const previousAverage = Number(prior?.count) ? Math.round(Number(prior.gross) / Number(prior.count)) : 0;
      return { currency: row.currency, cents: Number(row.average_cents ?? 0), changePercent: percentChange(Number(row.average_cents ?? 0), previousAverage) };
    }),
    revenueByCurrency: [...new Set([...revenueResult.rows.map((row) => row.currency), ...refundResult.rows.map((row) => row.currency).filter(Boolean), ...comparisonResult[3].rows.map((row) => row.currency)])].map((currency) => {
      const grossCents = Number(revenueResult.rows.find((row) => row.currency === currency)?.gross_cents ?? 0);
      const refundedCents = Number(refundResult.rows.find((row) => row.currency === currency)?.refunded_cents ?? 0);
      return { currency, grossCents, refundedCents, netCents: grossCents - refundedCents };
    }),
  };
  const comparisons = comparisonResult.slice(0, 3).map((result, index) => {
    const current = index === 0 ? metrics.registrations : index === 1 ? metrics.pinsCreated : metrics.activeUsers;
    const previous = Number(result.rows[0]?.value ?? 0);
    return { metric: ["registrations", "pinsCreated", "activeUsers"][index], current, previous, changePercent: percentChange(current, previous) };
  });
  comparisons.push({ metric: "transactions", current: metrics.transactions, previous: Number(comparisonResult[4].rows[0]?.value ?? 0), changePercent: percentChange(metrics.transactions, Number(comparisonResult[4].rows[0]?.value ?? 0)) });
  const revenueChanges = metrics.revenueByCurrency.map((row) => {
    const previous = Number(comparisonResult[3].rows.find((item) => item.currency === row.currency)?.gross ?? 0);
    return { currency: row.currency, current: row.grossCents, previous, changePercent: percentChange(row.grossCents, previous) };
  });
  const days = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"];
  const highlights: string[] = [];
  for (const item of comparisons) if (item.metric === "registrations" || item.metric === "pinsCreated") {
    if (item.changePercent != null && item.previous > 0 && item.changePercent !== 0) highlights.push(`${item.metric === "registrations" ? "Rejestracje" : "Nowe pinezki"} ${item.changePercent > 0 ? "wzrosły" : "spadły"} o ${Math.abs(item.changePercent)}% względem poprzedniego okresu.`);
  }
  const topUser = leadersResult.rows[0];
  if (topUser && Number(topUser.events) > 0) highlights.push(`Najaktywniejsze konto w okresie: ${topUser.name} (${topUser.events} zdarzeń).`);
  const busiest = weekdaysResult.rows[0];
  if (busiest) highlights.push(`Najwięcej pinezek dodano w ${days[Number(busiest.day) - 1]}.`);
  const anomalyRows = anomalyResult as typeof anomalyResult;
  const prevPins = Number(anomalyRows[1].rows[0]?.value ?? 0) / 30;
  const currentPins = Number(anomalyRows[0].rows[0]?.value ?? 0) / 7;
  const prevRegistrations = Number(anomalyRows[3].rows[0]?.value ?? 0) / 30;
  const currentRegistrations = Number(anomalyRows[2].rows[0]?.value ?? 0) / 7;
  const prevActiveUsers = Number(anomalyRows[6].rows[0]?.value ?? 0) / 30;
  const currentActiveUsers = Number(anomalyRows[5].rows[0]?.value ?? 0) / 7;
  const anomalySignals = [
    ...(prevPins >= 1 && currentPins > prevPins * 2 ? [{ kind: "pin_spike", message: "W ostatnim tygodniu tempo dodawania pinezek przekroczyło dwukrotność średniej z poprzednich 30 dni." }] : []),
    ...(prevActiveUsers >= 1 && currentActiveUsers < prevActiveUsers * 0.5 ? [{ kind: "activity_drop", message: "Liczba aktywnych kont w ostatnim tygodniu spadła poniżej połowy wcześniejszej średniej." }] : []),
    ...(prevRegistrations >= 1 && currentRegistrations > prevRegistrations * 2 ? [{ kind: "registration_spike", message: "Tempo nowych rejestracji w ostatnim tygodniu przekroczyło dwukrotność średniej z poprzednich 30 dni." }] : []),
    ...(Number(anomalyRows[4].rows[0]?.value ?? 0) >= 5 ? [{ kind: "payment_failures", message: "W ostatnim tygodniu wystąpiło co najmniej 5 nieudanych lub wygasłych płatności." }] : []),
  ];
  if (!highlights.length) highlights.push("Brak wyraźnych zmian w tym okresie.");
  const funnel = funnelResult.rows[0] ?? { registered: 0, active: 0, pinned: 0, paid: 0 };
  const retention = retentionResult.rows[0] ?? { registered: 0, day1_eligible: 0, day1: 0, day7_eligible: 0, day7: 0, day30_eligible: 0, day30: 0 };
  res.json({
    generatedAt: new Date().toISOString(), range: { from: filters.from.toISOString(), to: filters.to.toISOString() }, metrics, comparisons, revenueChanges,
    series: seriesResult.rows.map((row) => ({ date: row.bucket, registrations: Number(row.registrations), pins: Number(row.pins), active: Number(row.active) })),
    highlights, anomalies: anomalySignals,
    funnel: { registered: Number(funnel.registered), active: Number(funnel.active), pinned: Number(funnel.pinned), paid: Number(funnel.paid) },
    retention: { cohort: Number(retention.registered), day1Eligible: Number(retention.day1_eligible), day1: Number(retention.day1), day7Eligible: Number(retention.day7_eligible), day7: Number(retention.day7), day30Eligible: Number(retention.day30_eligible), day30: Number(retention.day30) },
    dataAvailability: { categories: "available_for_new_pins_only", markerEdits: "not_recorded_before_analytics", refunds: "tracked_from_analytics_release" },
  });
});

router.get("/analytics/users", async (req, res): Promise<void> => {
  try {
    const filters = parseFilters(req); const page = pageParams(req);
    const sort = typeof req.query.sort === "string" ? req.query.sort : "active";
    const orderBy = sort === "pins" ? "pins DESC, u.id" : sort === "payments" ? "COALESCE(pac.payments_pln,0) DESC, u.id" : sort === "newest" ? "u.created_at DESC" : "events DESC, u.id";
    const params: unknown[] = [filters.from, filters.to];
    const userCondition = filters.userId ? (params.push(filters.userId), `AND u.id=$${params.length}`) : "";
    const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
    const searchCondition = search ? (params.push(`%${search}%`), `AND u.name ILIKE $${params.length}`) : "";
    params.push(page.limit, page.offset);
    const { rows } = await pool.query(`WITH activity AS (
        SELECT COALESCE(actor_user_id,tenant_user_id) AS user_id, count(*)::int AS events, max(created_at) AS last_activity
        FROM audit_logs WHERE created_at >= $1 AND created_at < $2 AND COALESCE(actor_user_id,tenant_user_id) IS NOT NULL GROUP BY 1),
      pin_counts AS (SELECT owner_user_id, count(*)::int AS pins FROM markers WHERE created_at >= $1 AND created_at < $2 GROUP BY 1),
      payment_counts AS (SELECT creator_user_id, count(*) FILTER (WHERE status='paid')::int AS paid_transactions,
        sum(currency_total) FILTER (WHERE currency='pln')::bigint AS payments_pln,
        jsonb_object_agg(currency, currency_total) AS payments_by_currency FROM (
          SELECT creator_user_id, currency, sum(amount_cents) FILTER (WHERE status='paid')::bigint AS currency_total
          FROM stripe_pin_purchases WHERE created_at >= $1 AND created_at < $2 GROUP BY creator_user_id,currency
        ) p GROUP BY creator_user_id),
      total AS (SELECT count(*)::int AS count FROM users u WHERE true ${userCondition} ${searchCondition})
      SELECT u.id,u.name,u.role,u.created_at AS "createdAt", COALESCE(a.events,0)::int AS events,
        COALESCE(pc.pins,0)::int AS pins, COALESCE(pac.paid_transactions,0)::int AS "paidTransactions",
        COALESCE(pac.payments_pln,0)::bigint AS "paymentsPlnCents",
        COALESCE(pac.payments_by_currency,'{}'::jsonb) AS "paymentsByCurrency", a.last_activity AS "lastActivity",
        round(100.0*COALESCE(a.events,0)/nullif((SELECT count(*) FROM audit_logs aa WHERE aa.created_at >= $1 AND aa.created_at < $2 AND COALESCE(aa.actor_user_id,aa.tenant_user_id) IS NOT NULL),0),1) AS "eventsSharePercent",
        round(100.0*COALESCE(pc.pins,0)/nullif((SELECT count(*) FROM markers mm WHERE mm.created_at >= $1 AND mm.created_at < $2),0),1) AS "pinsSharePercent",
        (SELECT count(*)::int FROM markers m WHERE m.owner_user_id=u.id) AS "allPins",
        (SELECT count(*)::int FROM users u2 WHERE u2.created_at >= $1 AND u2.created_at < $2) AS "newUsersInPeriod",
        (SELECT count(*)::int FROM audit_logs aa WHERE COALESCE(aa.actor_user_id,aa.tenant_user_id)=u.id AND aa.created_at >= now()-interval '1 day') AS "events24h",
        total.count AS "totalUsers"
      FROM users u LEFT JOIN activity a ON a.user_id=u.id LEFT JOIN pin_counts pc ON pc.owner_user_id=u.id LEFT JOIN payment_counts pac ON pac.creator_user_id=u.id CROSS JOIN total
      WHERE true ${userCondition} ${searchCondition} ORDER BY ${orderBy} LIMIT $${params.length-1} OFFSET $${params.length}`, params);
    const total = Number(rows[0]?.totalUsers ?? 0);
    res.json({ page: page.page, limit: page.limit, total, rows: rows.map(({ totalUsers: _total, newUsersInPeriod: _new, ...row }) => row) });
  } catch (error) { filterError(res, error); }
});

router.get("/analytics/users/:userId", async (req, res): Promise<void> => {
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) { res.status(400).json({ error: "Nieprawidłowe konto." }); return; }
  let filters: Filters;
  try { filters = parseFilters(req); } catch (error) { filterError(res, error); return; }
  const [userResult, activityResult, pinsResult, paymentsResult] = await Promise.all([
    pool.query(`SELECT id,name,role,created_at AS "createdAt",parent_user_id AS "parentUserId",pin_balance AS "pinBalance" FROM users WHERE id=$1`, [userId]),
    pool.query(`SELECT id,event_type AS "eventType",details - ${PRIVATE_AUDIT_DETAIL_KEYS} AS details,created_at AS "createdAt" FROM audit_logs WHERE (actor_user_id=$1 OR tenant_user_id=$1) AND created_at >= $2 AND created_at < $3 ORDER BY created_at DESC LIMIT 100`, [userId, filters.from, filters.to]),
    pool.query(`SELECT id,title,category,lat,lng,created_at AS "createdAt",activated_at AS "activatedAt",archived_at AS "archivedAt" FROM markers WHERE owner_user_id=$1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at DESC LIMIT 100`, [userId, filters.from, filters.to]),
    pool.query(`SELECT id,package_id AS "packageId",pins,amount_cents AS "amountCents",refund_amount_cents AS "refundAmountCents",currency,status,created_at AS "createdAt",paid_at AS "paidAt" FROM stripe_pin_purchases WHERE creator_user_id=$1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at DESC LIMIT 100`, [userId, filters.from, filters.to]),
  ]);
  const user = userResult.rows[0];
  if (!user) { res.status(404).json({ error: "Nie znaleziono konta." }); return; }
  res.json({ user, activity: activityResult.rows, pins: pinsResult.rows, payments: paymentsResult.rows });
});

router.get("/analytics/pins", async (req, res): Promise<void> => {
  try {
    const filters = parseFilters(req); const page = pageParams(req);
    const params: unknown[] = [];
    const conditions = whereParts(filters, "owner_user_id", params, { categoryColumn: "category", bbox: true });
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const listParams = [...params, page.limit, page.offset];
    const [list, total, authors, categories, series, mapPoints] = await Promise.all([
      pool.query(`SELECT m.id,m.owner_user_id AS "ownerUserId",u.name AS "ownerName",m.title,m.category,m.lat,m.lng,m.created_at AS "createdAt",m.activated_at AS "activatedAt",m.archived_at AS "archivedAt" FROM markers m JOIN users u ON u.id=m.owner_user_id ${where.replaceAll("owner_user_id", "m.owner_user_id").replaceAll("created_at", "m.created_at").replaceAll("category", "m.category").replaceAll("lat", "m.lat").replaceAll("lng", "m.lng")} ORDER BY m.created_at DESC LIMIT $${listParams.length-1} OFFSET $${listParams.length}`, listParams),
      pool.query(`SELECT count(*)::int AS total FROM markers m ${where.replaceAll("owner_user_id", "m.owner_user_id").replaceAll("created_at", "m.created_at").replaceAll("category", "m.category").replaceAll("lat", "m.lat").replaceAll("lng", "m.lng")}`, params),
      pool.query(`SELECT u.id,u.name,count(m.id)::int AS pins,round(100.0*count(m.id)/nullif(sum(count(m.id)) over(),0),1) AS share FROM markers m JOIN users u ON u.id=m.owner_user_id ${where.replaceAll("owner_user_id", "m.owner_user_id").replaceAll("created_at", "m.created_at").replaceAll("category", "m.category").replaceAll("lat", "m.lat").replaceAll("lng", "m.lng")} GROUP BY u.id ORDER BY pins DESC LIMIT 20`, params),
      pool.query(`SELECT category,count(*)::int AS pins FROM markers ${where} GROUP BY category ORDER BY pins DESC LIMIT 30`, params),
      pool.query(`SELECT date_trunc('day',created_at) AS date,count(*)::int AS pins FROM markers ${where} GROUP BY 1 ORDER BY 1 LIMIT 400`, params),
      pool.query(`SELECT m.id,m.title,m.category,m.owner_user_id AS "ownerUserId",u.name AS "ownerName",m.lat,m.lng,m.created_at AS "createdAt" FROM markers m JOIN users u ON u.id=m.owner_user_id ${where.replaceAll("owner_user_id", "m.owner_user_id").replaceAll("created_at", "m.created_at").replaceAll("category", "m.category").replaceAll("lat", "m.lat").replaceAll("lng", "m.lng")} ORDER BY m.created_at DESC LIMIT 5000`, params),
    ]);
    res.json({ page: page.page, limit: page.limit, total: Number(total.rows[0]?.total ?? 0), rows: list.rows, mapPoints: mapPoints.rows, authors: authors.rows,
      categories: categories.rows, series: series.rows.map((row) => ({ date: row.date, pins: Number(row.pins) })),
      categoryHistoryNote: "Pinezki utworzone przed dodaniem kategorii nie mają przypisanej kategorii." });
  } catch (error) { filterError(res, error); }
});

router.get("/analytics/finance", async (req, res): Promise<void> => {
  try {
    const filters = parseFilters(req); const page = pageParams(req);
    const params: unknown[] = [];
    params.push(filters.from, filters.to);
    const conditions = ["p.created_at >= $1", "p.created_at < $2"];
    if (filters.userId) { params.push(filters.userId); conditions.push(`p.creator_user_id=$${params.length}`); }
    const statusExpression = "CASE WHEN p.refund_amount_cents >= p.amount_cents AND p.status='paid' THEN 'refunded' WHEN p.refund_amount_cents > 0 AND p.status='paid' THEN 'partially_refunded' ELSE p.status END";
    if (filters.status) { params.push(filters.status); conditions.push(`${statusExpression}=$${params.length}`); }
    const currency = typeof req.query.currency === "string" && /^[a-z]{3}$/i.test(req.query.currency) ? req.query.currency.toLowerCase() : null;
    if (currency) { params.push(currency); conditions.push(`p.currency=$${params.length}`); }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const eventParams: unknown[] = [filters.from, filters.to];
    const eventConditions = ["event_type='pin_pack_refunded'", "created_at >= $1", "created_at < $2"];
    if (filters.userId) { eventParams.push(filters.userId); eventConditions.push(`tenant_user_id=$${eventParams.length}`); }
    if (currency) { eventParams.push(currency); eventConditions.push(`details->>'currency'=$${eventParams.length}`); }
    const eventWhere = `WHERE ${eventConditions.join(" AND ")}`;
    const revenueParams: unknown[] = [filters.from, filters.to];
    const revenueConditions = ["p.status='paid'", "p.paid_at >= $1", "p.paid_at < $2"];
    if (filters.userId) { revenueParams.push(filters.userId); revenueConditions.push(`p.creator_user_id=$${revenueParams.length}`); }
    if (currency) { revenueParams.push(currency); revenueConditions.push(`p.currency=$${revenueParams.length}`); }
    if (filters.status) { revenueParams.push(filters.status); revenueConditions.push(`${statusExpression}=$${revenueParams.length}`); }
    const revenueWhere = `WHERE ${revenueConditions.join(" AND ")}`;
    const chartBucket = filters.to.getTime() - filters.from.getTime() <= 366 * 86400000 ? "day" : "week";
    const listParams = [...params, page.limit, page.offset];
    const [rows, statusTotals, revenueTotals, refunds, payers, series] = await Promise.all([
      pool.query(`SELECT p.id,p.creator_user_id AS "userId",u.name AS "userName",p.package_id AS "packageId",p.pins,p.amount_cents AS "amountCents",p.refund_amount_cents AS "refundAmountCents",p.currency,${statusExpression} AS status,p.created_at AS "createdAt",p.paid_at AS "paidAt" FROM stripe_pin_purchases p JOIN users u ON u.id=p.creator_user_id ${where} ORDER BY p.created_at DESC LIMIT $${listParams.length-1} OFFSET $${listParams.length}`, listParams),
      pool.query(`SELECT p.currency,count(*)::int AS transactions,count(*) FILTER (WHERE p.status='paid')::int AS paid_transactions,
        count(*) FILTER (WHERE p.status='pending')::int AS pending,count(*) FILTER (WHERE p.status='failed')::int AS failed,count(*) FILTER (WHERE p.status='expired')::int AS expired,
        count(*) FILTER (WHERE p.status='paid' AND p.refund_amount_cents >= p.amount_cents)::int AS refunded,
        count(*) FILTER (WHERE p.status='paid' AND p.refund_amount_cents > 0 AND p.refund_amount_cents < p.amount_cents)::int AS partially_refunded
        FROM stripe_pin_purchases p ${where} GROUP BY p.currency ORDER BY p.currency`, params),
      pool.query(`SELECT p.currency,count(*)::int AS paid_transactions,COALESCE(sum(p.amount_cents),0)::bigint AS gross_cents,
        count(DISTINCT p.creator_user_id)::int AS payers,round(avg(p.amount_cents))::bigint AS average_cents
        FROM stripe_pin_purchases p ${revenueWhere} GROUP BY p.currency ORDER BY p.currency`, revenueParams),
      pool.query(`SELECT details->>'currency' AS currency,COALESCE(sum((details->>'refundDeltaCents')::bigint),0)::bigint AS amount_cents,count(*)::int AS events FROM audit_logs ${eventWhere} GROUP BY 1 ORDER BY 1`, eventParams),
      pool.query(`WITH sums AS (SELECT u.id,u.name,p.currency,sum(p.amount_cents)::bigint AS gross_cents,count(*)::int AS transactions
        FROM stripe_pin_purchases p JOIN users u ON u.id=p.creator_user_id WHERE p.status='paid' AND p.paid_at >= $1 AND p.paid_at < $2
        GROUP BY u.id,u.name,p.currency), ranked AS (SELECT *,round(100.0*gross_cents/nullif(sum(gross_cents) over(partition by currency),0),1) AS share FROM sums)
        SELECT * FROM ranked WHERE ($3::int IS NULL OR id=$3) AND ($4::text IS NULL OR currency=$4) ORDER BY currency,gross_cents DESC LIMIT 50`, [filters.from, filters.to, filters.userId, currency]),
      pool.query(`SELECT date_trunc('${chartBucket}',p.paid_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS date,p.currency,sum(p.amount_cents)::bigint AS "grossCents",count(*)::int AS transactions
        FROM stripe_pin_purchases p ${revenueWhere} GROUP BY 1,p.currency ORDER BY 1,p.currency LIMIT 1200`, revenueParams),
    ]);
    const currencies = new Set([...statusTotals.rows.map((row) => row.currency), ...revenueTotals.rows.map((row) => row.currency), ...refunds.rows.map((row) => row.currency).filter(Boolean)]);
    const totals = [...currencies].map((currencyCode) => {
      const statusRow = statusTotals.rows.find((row) => row.currency === currencyCode) ?? {};
      const revenueRow = revenueTotals.rows.find((row) => row.currency === currencyCode) ?? {};
      const refundCents = Number(refunds.rows.find((row) => row.currency === currencyCode)?.amount_cents ?? 0);
      const grossCents = Number(revenueRow.gross_cents ?? 0);
      return { ...statusRow, currency: currencyCode, gross_cents: grossCents, current_refunded_cents: refundCents, net_cents: grossCents - refundCents, payers: Number(revenueRow.payers ?? 0), average_cents: Number(revenueRow.average_cents ?? 0) };
    });
    res.json({ page: page.page, limit: page.limit, total: Number((await pool.query(`SELECT count(*)::int AS total FROM stripe_pin_purchases p ${where}`, params)).rows[0]?.total ?? 0),
      totals, refundsInRange: [...currencies].map((currencyCode) => ({ currency: currencyCode, cents: Number(refunds.rows.find((row) => row.currency === currencyCode)?.amount_cents ?? 0) })),
      payers: payers.rows, rows: rows.rows, series: series.rows.map((row) => ({ ...row, grossCents: Number(row.grossCents), transactions: Number(row.transactions) })),
      currencyNote: "Kwoty w różnych walutach są raportowane osobno; serwis nie przelicza walut. Wykres grupuje wyniki dziennie, a długie zakresy tygodniowo." });
  } catch (error) { filterError(res, error); }
});

router.get("/analytics/activity", async (req, res): Promise<void> => {
  try {
    const filters = parseFilters(req); const page = pageParams(req);
    const params: unknown[] = [];
    const conditions = whereParts(filters, "COALESCE(a.actor_user_id,a.tenant_user_id)", params, { dateColumn: "a.created_at" });
    if (filters.eventType) { params.push(filters.eventType); conditions.push(`a.event_type=$${params.length}`); }
    if (filters.status) { params.push(filters.status); conditions.push(`a.details->>'status'=$${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const listParams = [...params, page.limit, page.offset];
    const [rows, total] = await Promise.all([
      pool.query(`SELECT a.id,a.event_type AS "eventType",a.actor_user_id AS "actorUserId",actor.name AS "actorName",a.tenant_user_id AS "tenantUserId",tenant.name AS "tenantName",a.details - ${PRIVATE_AUDIT_DETAIL_KEYS} AS details,a.created_at AS "createdAt" FROM audit_logs a LEFT JOIN users actor ON actor.id=a.actor_user_id LEFT JOIN users tenant ON tenant.id=a.tenant_user_id ${where.replaceAll("created_at", "a.created_at").replaceAll("event_type", "a.event_type").replaceAll("details->>", "a.details->>").replaceAll("COALESCE(a.actor_user_id,a.tenant_user_id)", "COALESCE(a.actor_user_id,a.tenant_user_id)")} ORDER BY a.created_at DESC LIMIT $${listParams.length-1} OFFSET $${listParams.length}`, listParams),
      pool.query(`SELECT count(*)::int AS total FROM audit_logs a ${where.replaceAll("created_at", "a.created_at").replaceAll("event_type", "a.event_type").replaceAll("details->>", "a.details->>")}`, params),
    ]);
    res.json({ page: page.page, limit: page.limit, total: Number(total.rows[0]?.total ?? 0), rows: rows.rows,
      historyNote: "Dziennik obejmuje tylko zdarzenia zapisane przez aplikację. Brakujących zdarzeń historycznych nie odtwarzamy." });
  } catch (error) { filterError(res, error); }
});

router.get("/analytics/export.csv", async (req, res): Promise<void> => {
  try {
    const filters = parseFilters(req);
    const dataset = req.query.dataset;
    let headings: string[]; let values: unknown[][];
    if (dataset === "users") {
      const params: unknown[] = [filters.from, filters.to];
      const extra = filters.userId ? (params.push(filters.userId), `AND u.id=$${params.length}`) : "";
      const rows = await pool.query(`SELECT u.id,u.name,u.role,u.created_at,count(DISTINCT m.id)::int AS pins,count(DISTINCT a.id)::int AS events FROM users u LEFT JOIN markers m ON m.owner_user_id=u.id AND m.created_at >= $1 AND m.created_at < $2 LEFT JOIN audit_logs a ON COALESCE(a.actor_user_id,a.tenant_user_id)=u.id AND a.created_at >= $1 AND a.created_at < $2 WHERE true ${extra} GROUP BY u.id ORDER BY u.id LIMIT ${EXPORT_MAX}`, params);
      headings = ["id", "nazwa", "rola", "rejestracja", "pinezki_w_okresie", "zdarzenia_w_okresie"]; values = rows.rows.map((r) => [r.id,r.name,r.role,r.created_at,r.pins,r.events]);
    } else if (dataset === "pins") {
      const params: unknown[] = []; const conditions = whereParts(filters, "owner_user_id", params, { categoryColumn: "category", bbox: true });
      const rows = await pool.query(`SELECT m.id,u.name,m.title,m.category,m.lat,m.lng,m.created_at,m.activated_at,m.archived_at FROM markers m JOIN users u ON u.id=m.owner_user_id WHERE ${conditions.map((c)=>c.replaceAll("owner_user_id","m.owner_user_id").replaceAll("created_at","m.created_at").replaceAll("category","m.category").replaceAll("lat","m.lat").replaceAll("lng","m.lng")).join(" AND ")} ORDER BY m.created_at DESC LIMIT ${EXPORT_MAX}`, params);
      headings = ["id", "kreator", "tytul", "kategoria", "lat", "lng", "utworzono", "aktywacja", "archiwizacja"]; values = rows.rows.map((r) => [r.id,r.name,r.title,r.category,r.lat,r.lng,r.created_at,r.activated_at,r.archived_at]);
    } else if (dataset === "payments") {
      const params: unknown[] = [filters.from, filters.to]; const extra = filters.userId ? (params.push(filters.userId), `AND p.creator_user_id=$${params.length}`) : "";
      if (filters.status) { params.push(filters.status); }
      const statusCondition = filters.status ? `AND CASE WHEN p.refund_amount_cents >= p.amount_cents AND p.status='paid' THEN 'refunded' WHEN p.refund_amount_cents > 0 AND p.status='paid' THEN 'partially_refunded' ELSE p.status END=$${params.length}` : "";
      const statusExpression = "CASE WHEN p.refund_amount_cents >= p.amount_cents AND p.status='paid' THEN 'refunded' WHEN p.refund_amount_cents > 0 AND p.status='paid' THEN 'partially_refunded' ELSE p.status END";
      const rows = await pool.query(`SELECT p.id,u.name,p.package_id,p.pins,p.amount_cents,p.refund_amount_cents,p.currency,${statusExpression} AS status,p.created_at,p.paid_at FROM stripe_pin_purchases p JOIN users u ON u.id=p.creator_user_id WHERE p.created_at >= $1 AND p.created_at < $2 ${extra} ${statusCondition} ORDER BY p.created_at DESC LIMIT ${EXPORT_MAX}`, params);
      headings = ["id", "kreator", "pakiet", "pinezki", "kwota_grosze", "zwrot_grosze", "waluta", "status", "utworzono", "oplacono"]; values = rows.rows.map((r) => [r.id,r.name,r.package_id,r.pins,r.amount_cents,r.refund_amount_cents,r.currency,r.status,r.created_at,r.paid_at]);
    } else if (dataset === "activity") {
      const params: unknown[] = []; const conditions = whereParts(filters, "COALESCE(a.actor_user_id,a.tenant_user_id)", params, { dateColumn: "a.created_at" });
      if (filters.eventType) { params.push(filters.eventType); conditions.push(`a.event_type=$${params.length}`); }
      if (filters.status) { params.push(filters.status); conditions.push(`a.details->>'status'=$${params.length}`); }
      const rows = await pool.query(`SELECT a.id,a.created_at,a.event_type,a.actor_user_id,actor.name AS actor_name,a.tenant_user_id FROM audit_logs a LEFT JOIN users actor ON actor.id=a.actor_user_id WHERE ${conditions.join(" AND ")} ORDER BY a.created_at DESC LIMIT ${EXPORT_MAX}`, params);
      headings = ["id", "data", "zdarzenie", "uzytkownik_id", "uzytkownik", "konto_id"]; values = rows.rows.map((r) => [r.id,r.created_at,r.event_type,r.actor_user_id,r.actor_name,r.tenant_user_id]);
    } else { res.status(400).json({ error: "Wybierz raport: users, pins, payments albo activity." }); return; }
    const csv = [headings, ...values].map((line) => line.map(csvCell).join(",")).join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="pysne-${dataset}-${filters.from.toISOString().slice(0,10)}-${filters.to.toISOString().slice(0,10)}.csv"`);
    res.send(`\uFEFF${csv}`);
  } catch (error) { filterError(res, error); }
});

export default router;

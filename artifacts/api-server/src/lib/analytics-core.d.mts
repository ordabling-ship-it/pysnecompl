export type AnalyticsSessionUser = { id: number } | null;
export function analyticsAccessStatus(user: AnalyticsSessionUser): 200 | 401 | 403;
export function percentChange(current: number, previous: number): number | null;
export function csvCell(value: unknown): string;

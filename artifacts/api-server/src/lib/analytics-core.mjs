export function hasAnalyticsAccess(user) {
  if (!user) return false;
  if (user.role === "master_admin") return true;
  return user.role === "moderator" &&
    typeof user.slug === "string" &&
    user.slug.toLowerCase() === "don_lisciasty";
}

export function analyticsAccessStatus(user) {
  if (!user) return 401;
  return hasAnalyticsAccess(user) ? 200 : 403;
}

export function percentChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export function csvCell(value) {
  let text = value == null ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

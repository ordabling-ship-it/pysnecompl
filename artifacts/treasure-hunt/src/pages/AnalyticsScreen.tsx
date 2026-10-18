import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowLeft, BarChart3, Download, FileText, MapPinned, RefreshCw, Search, Users, WalletCards, X } from "lucide-react";

type Tab = "overview" | "users" | "pins" | "finance" | "activity" | "reports";
type AnyRow = Record<string, any>;
type Overview = {
  range: { from: string; to: string };
  metrics: AnyRow;
  comparisons: Array<{ metric: string; current: number; previous: number; changePercent: number | null }>;
  revenueChanges: Array<{ currency: string; current: number; previous: number; changePercent: number | null }>;
  series: Array<{ date: string; registrations: number; pins: number; active: number }>;
  highlights: string[];
  anomalies: Array<{ kind: string; message: string }>;
  funnel: { registered: number; active: number; pinned: number; paid: number };
  retention: { cohort: number; day1Eligible: number; day1: number; day7Eligible: number; day7: number; day30Eligible: number; day30: number };
  dataAvailability: Record<string, string>;
};

const tabs: Array<{ id: Tab; label: string; icon: typeof BarChart3 }> = [
  { id: "overview", label: "Przegląd", icon: BarChart3 }, { id: "users", label: "Użytkownicy", icon: Users },
  { id: "pins", label: "Pinezki", icon: MapPinned }, { id: "finance", label: "Finanse", icon: WalletCards },
  { id: "activity", label: "Historia aktywności", icon: RefreshCw }, { id: "reports", label: "Raporty", icon: FileText },
];

const dateValue = (value: Date) => value.toISOString().slice(0, 10);
function presetRange(preset: string): [string, string] {
  const now = new Date(); const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = (date: Date) => dateValue(date);
  if (preset === "today") return [end(today), end(today)];
  if (preset === "yesterday") { const y = new Date(today); y.setUTCDate(y.getUTCDate() - 1); return [end(y), end(y)]; }
  if (preset === "7") { const d = new Date(today); d.setUTCDate(d.getUTCDate() - 6); return [end(d), end(today)]; }
  if (preset === "30") { const d = new Date(today); d.setUTCDate(d.getUTCDate() - 29); return [end(d), end(today)]; }
  if (preset === "thisMonth") return [end(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), end(today)];
  if (preset === "previousMonth") return [end(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))), end(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)))];
  if (preset === "year") return [end(new Date(Date.UTC(now.getUTCFullYear(), 0, 1))), end(today)];
  if (preset === "all") return ["1970-01-01", end(today)];
  const start = new Date(today); start.setUTCDate(start.getUTCDate() - 29); return [end(start), end(today)];
}

function useAnalyticsData<T>(url: string | null, refreshKey = 0) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const refresh = useCallback(() => setRefresh((value) => value + 1), []);
  const [refreshKeyInternal, setRefresh] = useState(0);
  useEffect(() => {
    if (!url) { setData(null); setError(""); return; }
    let active = true; setLoading(true); setError("");
    fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Nie udało się pobrać danych."); return body as T; })
      .then((body) => { if (active) setData(body); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Błąd połączenia."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [url, refreshKey, refreshKeyInternal]);
  return { data, error, loading, refresh };
}

function queryUrl(path: string, params: URLSearchParams): string { return `${path}?${params.toString()}`; }
function money(cents: number, currency = "PLN"): string { return new Intl.NumberFormat("pl-PL", { style: "currency", currency: currency.toUpperCase() }).format((Number(cents) || 0) / 100); }
function number(value: unknown): string { return new Intl.NumberFormat("pl-PL").format(Number(value) || 0); }
function dateTime(value: string | null | undefined): string { return value ? new Date(value).toLocaleString("pl-PL") : "—"; }
function percent(value: number | null): string { return value == null ? "brak porównania" : `${value > 0 ? "+" : ""}${value}%`; }
function roleLabel(role: unknown): string {
  const labels: Record<string, string> = { master_admin: "Master Admin", moderator: "Moderator", admin: "Kreator" };
  return labels[String(role)] ?? "Inna rola";
}
function paymentStatusLabel(status: unknown): string {
  const labels: Record<string, string> = {
    pending: "Oczekuje na płatność", paid: "Opłacona", failed: "Nieudana", expired: "Wygasła",
    partially_refunded: "Częściowo zwrócona", refunded: "Zwrócona",
  };
  return labels[String(status)] ?? "Inny status";
}
function eventLabel(eventType: unknown): string {
  const labels: Record<string, string> = {
    account_created: "Utworzono konto", account_activated: "Aktywowano konto",
    account_invite_issued: "Wysłano zaproszenie do konta", account_password_reset: "Zmieniono hasło do konta",
    marker_created: "Dodano skarb", marker_archived: "Zarchiwizowano skarb",
    treasure_activated: "Odbiorca rozpoczął grę", guest_code_entered: "Odbiorca wpisał token",
    code_redeemed: "Użyto tokenu", admin_login: "Logowanie do panelu",
    master_bootstrapped: "Utworzono konto Master Admina", moderator_created: "Utworzono konto Moderatora",
    pin_pack_payment_started: "Rozpoczęto płatność za pakiet pinezek",
    pin_pack_payment_failed: "Płatność za pakiet pinezek nie powiodła się",
    pin_pack_payment_expired: "Sesja płatności wygasła", pin_pack_purchased: "Kupiono pakiet pinezek",
    pin_pack_refunded: "Zwrócono płatność za pakiet pinezek",
  };
  return labels[String(eventType)] ?? "Inne zdarzenie";
}
function activityActorLabel(row: { eventType?: string; actorName?: string | null }): string {
  if (row.actorName) return row.actorName;
  return row.eventType === "treasure_activated" || row.eventType === "guest_code_entered" ? "Odbiorca" : "System";
}
function packageLabel(packageId: unknown): string {
  const labels: Record<string, string> = { start: "Start", growth: "Rozwój", popular: "Popularny", event: "Event" };
  return labels[String(packageId)] ?? "Pakiet";
}

function Panel({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900 sm:p-5"><div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-semibold">{title}</h2>{action}</div>{children}</section>;
}

function PinMap({ rows, onBounds }: { rows: AnyRow[]; onBounds: (bounds: L.LatLngBounds) => void }) {
  const node = useRef<HTMLDivElement>(null); const map = useRef<L.Map | null>(null); const group = useRef<L.LayerGroup | null>(null);
  const didFit = useRef(false);
  const [density, setDensity] = useState(false);
  useEffect(() => {
    if (!node.current || map.current) return;
    const instance = L.map(node.current, { zoomControl: true, scrollWheelZoom: false }).setView([53.43, 14.55], 12);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom: 19, attribution: "© OpenStreetMap © CARTO" }).addTo(instance);
    group.current = L.layerGroup().addTo(instance); map.current = instance;
    return () => { instance.remove(); map.current = null; group.current = null; };
  }, []);
  useEffect(() => {
    if (!group.current) return;
    group.current.clearLayers();
    if (!didFit.current && rows.length) {
      const valid = rows.filter((row) => Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lng)));
      if (valid.length) {
        const bounds = L.latLngBounds(valid.map((row) => [Number(row.lat), Number(row.lng)] as L.LatLngTuple));
        map.current?.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 });
        didFit.current = true;
      }
    }
    if (density) {
      const cells = new Map<string, { lat: number; lng: number; count: number }>();
      for (const row of rows) {
        const lat = Number(row.lat); const lng = Number(row.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const key = `${Math.round(lat * 100)},${Math.round(lng * 100)}`;
        const cell = cells.get(key) ?? { lat: 0, lng: 0, count: 0 };
        cell.lat += lat; cell.lng += lng; cell.count += 1; cells.set(key, cell);
      }
      for (const cell of cells.values()) {
        const count = cell.count; const color = count >= 20 ? "#dc2626" : count >= 8 ? "#ea580c" : "#eab308";
        const pin = L.circleMarker([cell.lat / count, cell.lng / count], { radius: Math.min(28, 8 + Math.sqrt(count) * 3), color, weight: 1, fillColor: color, fillOpacity: 0.45 });
        const content = document.createElement("div"); content.textContent = `${count} pinezek w komórce siatki ok. 1 km.`; pin.bindPopup(content).addTo(group.current);
      }
    } else for (const row of rows) {
      if (!Number.isFinite(Number(row.lat)) || !Number.isFinite(Number(row.lng))) continue;
      const pin = L.circleMarker([Number(row.lat), Number(row.lng)], { radius: 6, color: "#14532d", weight: 1, fillColor: "#22c55e", fillOpacity: 0.75 });
      const content = document.createElement("div");
      const title = document.createElement("strong"); title.textContent = String(row.title ?? "Pinezka"); content.appendChild(title);
      const owner = document.createElement("div"); owner.textContent = `Kreator: ${String(row.ownerName ?? "—")}`; content.appendChild(owner);
      const category = document.createElement("div"); category.textContent = `Kategoria: ${String(row.category ?? "brak danych")}`; content.appendChild(category);
      pin.bindPopup(content).addTo(group.current);
    }
  }, [rows, density]);
  return <div className="space-y-2"><div ref={node} className="h-[330px] overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700" aria-label="Mapa rozmieszczenia pinezek" /><div className="flex flex-wrap gap-2"><button type="button" aria-pressed={density} className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800" onClick={() => setDensity((value) => !value)}>{density ? "Pokaż pinezki" : "Pokaż zagęszczenie"}</button><button type="button" className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800" onClick={() => { if (map.current) onBounds(map.current.getBounds()); }}>Filtruj do widocznego obszaru mapy</button></div><p className="text-xs text-gray-500">Mapa obejmuje do 5000 pinezek z aktywnymi filtrami. Widok zagęszczenia grupuje je w komórkach około 1 km.</p></div>;
}

export default function AnalyticsScreen({ userId, userName, theme, onToggleTheme }: { userId: number; userName: string; theme: "light" | "dark"; onToggleTheme: () => void }) {
  const [tab, setTab] = useState<Tab>("overview"); const initial = presetRange("30");
  const [from, setFrom] = useState(initial[0]); const [to, setTo] = useState(initial[1]); const [preset, setPreset] = useState("30");
  const [selectedUser, setSelectedUser] = useState(""); const [category, setCategory] = useState(""); const [status, setStatus] = useState(""); const [eventType, setEventType] = useState("");
  const [page, setPage] = useState(1); const [profileId, setProfileId] = useState<number | null>(null); const [compareIds, setCompareIds] = useState<number[]>([]);
  const [bbox, setBbox] = useState<{ minLat: number; maxLat: number; minLng: number; maxLng: number } | null>(null);
  const [search, setSearch] = useState(""); const [exportError, setExportError] = useState("");
  const [userSort, setUserSort] = useState("active");
  const params = useMemo(() => {
    const value = new URLSearchParams({ from, to, page: String(page), limit: "25" });
    if (selectedUser) value.set("userId", selectedUser); if (category) value.set("category", category);
    if (status) value.set("status", status); if (eventType) value.set("eventType", eventType);
    if (bbox) for (const [key, bound] of Object.entries(bbox)) value.set(key, String(bound));
    return value;
  }, [from, to, page, selectedUser, category, status, eventType, bbox]);
  const filterOptions = useAnalyticsData<{ categories: string[]; eventTypes: string[] }>("/api/analytics/filters");
  const overviewUrl = queryUrl("/api/analytics/overview", params);
  const { data: overview, error: overviewError, loading: overviewLoading } = useAnalyticsData<Overview>(tab === "overview" ? overviewUrl : null);
  const usersUrl = queryUrl("/api/analytics/users", new URLSearchParams([...params, ["sort", userSort], ...(search ? [["q", search] as [string,string]] : [])]));
  const users = useAnalyticsData<{ rows: AnyRow[]; total: number }>(tab === "users" ? usersUrl : null);
  const pinsUrl = queryUrl("/api/analytics/pins", params);
  const pins = useAnalyticsData<{ rows: AnyRow[]; mapPoints: AnyRow[]; total: number; authors: AnyRow[]; categories: AnyRow[]; series: AnyRow[]; categoryHistoryNote: string }>(tab === "pins" ? pinsUrl : null);
  const financeUrl = queryUrl("/api/analytics/finance", params);
  const finance = useAnalyticsData<{ rows: AnyRow[]; total: number; totals: AnyRow[]; refundsInRange: AnyRow[]; payers: AnyRow[]; series: AnyRow[]; currencyNote: string }>(tab === "finance" ? financeUrl : null);
  const activityUrl = queryUrl("/api/analytics/activity", params);
  const activity = useAnalyticsData<{ rows: AnyRow[]; total: number; historyNote: string }>(tab === "activity" ? activityUrl : null);
  const profileParams = new URLSearchParams(params); profileParams.delete("page"); profileParams.delete("limit");
  const profile = useAnalyticsData<{ user: AnyRow; activity: AnyRow[]; pins: AnyRow[]; payments: AnyRow[] }>(profileId ? `/api/analytics/users/${profileId}?${profileParams}` : null);

  useEffect(() => { setPage(1); }, [tab, from, to, selectedUser, category, status, eventType, bbox]);
  const pickPreset = (value: string) => { setPreset(value); if (value !== "custom") { const range = presetRange(value); setFrom(range[0]); setTo(range[1]); } };
  const navigate = (target: Tab, user?: number) => { setTab(target); setPage(1); if (user) { setProfileId(user); setTab("users"); } };
  const openPinBucket = (state: any) => {
    const point = state?.activePayload?.[0];
    const bucket = point?.payload?.date;
    if (!bucket) { navigate("pins"); return; }
    const start = new Date(bucket);
    if (!Number.isFinite(start.getTime())) { navigate("pins"); return; }
    const days = new Date(overview?.range.to ?? to).getTime() - new Date(overview?.range.from ?? from).getTime() <= 366 * 86400000 ? 1 : 7;
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + days - 1);
    const target: Tab = point.dataKey === "registrations" ? "users" : point.dataKey === "active" ? "activity" : "pins";
    setFrom(dateValue(start)); setTo(dateValue(end)); setPreset("custom"); navigate(target);
  };
  const toggleCompare = (id: number) => setCompareIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : ids.length < 2 ? [...ids, id] : [ids[1], id]);
  const exportCsv = async (dataset: string) => {
    setExportError("");
    try { const response = await fetch(queryUrl("/api/analytics/export.csv", new URLSearchParams([...params, ["dataset", dataset]])), { credentials: "same-origin" }); if (!response.ok) { const body = await response.json(); throw new Error(body.error ?? "Eksport się nie powiódł."); } const blob = await response.blob(); const href = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = href; link.download = `pysne-${dataset}.csv`; link.click(); URL.revokeObjectURL(href); }
    catch (error) { setExportError(error instanceof Error ? error.message : "Eksport się nie powiódł."); }
  };
  const selectUserFromMap = (bounds: L.LatLngBounds) => { setBbox({ minLat: bounds.getSouth(), maxLat: bounds.getNorth(), minLng: bounds.getWest(), maxLng: bounds.getEast() }); };
  const pageContent = (loading: boolean, error: string, children: React.ReactNode) => loading ? <div className="rounded-xl border bg-white p-10 text-center text-sm text-gray-500 dark:bg-gray-900">Ładowanie danych…</div> : error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{error}</div> : children;
  const metric = (title: string, value: React.ReactNode, change?: string, onClick?: () => void) => <button type="button" onClick={onClick} className={`min-h-28 rounded-2xl border border-gray-200 bg-white p-4 text-left shadow-sm dark:border-gray-700 dark:bg-gray-900 ${onClick ? "hover:border-green-500 hover:shadow" : "cursor-default"}`}><div className="text-xs font-medium text-gray-500 dark:text-gray-400">{title}</div><div className="mt-2 text-2xl font-bold tracking-tight">{value}</div>{change && <div className="mt-1 text-xs text-gray-500">{change}</div>}</button>;

  return <main className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
    <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3"><a href="/" aria-label="Wróć do aplikacji" className="rounded-lg border p-2 hover:bg-gray-100 dark:hover:bg-gray-800"><ArrowLeft className="h-4 w-4" /></a><div className="min-w-0"><p className="text-xs font-medium uppercase tracking-wide text-green-700 dark:text-green-400">Pysne · panel globalny</p><h1 className="truncate text-lg font-bold sm:text-xl">Analityka serwisu</h1></div></div>
        <div className="flex items-center gap-2"><span className="hidden text-sm text-gray-500 sm:inline">{userName} · ID {userId}</span><button type="button" onClick={onToggleTheme} className="rounded-lg border px-3 py-2 text-xs font-medium">{theme === "dark" ? "Jasny" : "Ciemny"}</button></div>
      </div>
      <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2 sm:px-6" aria-label="Sekcje analityki">{tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => { setTab(id); setProfileId(null); }} aria-current={tab === id ? "page" : undefined} className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm ${tab === id ? "bg-green-800 font-semibold text-white" : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"}`}><Icon className="h-4 w-4" />{label}</button>)}</nav>
    </header>

    <div className="mx-auto max-w-7xl space-y-5 px-4 py-5 sm:px-6">
      <Panel title="Filtry wspólne" action={<button type="button" onClick={() => { const range = presetRange("30"); setPreset("30"); setFrom(range[0]); setTo(range[1]); setSelectedUser(""); setCategory(""); setStatus(""); setEventType(""); setBbox(null); setSearch(""); }} className="text-xs font-semibold text-green-800">Wyczyść filtry</button>}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
          <label className="text-xs text-gray-500">Okres<select value={preset} onChange={(e) => pickPreset(e.target.value)} className="mt-1 h-10 w-full rounded-lg border bg-white px-2 text-sm text-gray-900 dark:bg-gray-950 dark:text-white"><option value="today">Dzisiaj</option><option value="yesterday">Wczoraj</option><option value="7">7 dni</option><option value="30">30 dni</option><option value="thisMonth">Bieżący miesiąc</option><option value="previousMonth">Poprzedni miesiąc</option><option value="year">Bieżący rok</option><option value="all">Cały okres</option><option value="custom">Własny zakres</option></select></label>
          <label className="text-xs text-gray-500">Od<input type="date" value={from} onChange={(e) => { setPreset("custom"); setFrom(e.target.value); }} className="mt-1 h-10 w-full rounded-lg border bg-white px-2 text-sm text-gray-900 dark:bg-gray-950 dark:text-white" /></label>
          <label className="text-xs text-gray-500">Do<input type="date" value={to} onChange={(e) => { setPreset("custom"); setTo(e.target.value); }} className="mt-1 h-10 w-full rounded-lg border bg-white px-2 text-sm text-gray-900 dark:bg-gray-950 dark:text-white" /></label>
          <label className="text-xs text-gray-500">ID konta<input type="number" min="1" value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)} placeholder="Wszystkie" className="mt-1 h-10 w-full rounded-lg border bg-white px-2 text-sm text-gray-900 dark:bg-gray-950 dark:text-white" /></label>
          <label className="text-xs text-gray-500">Kategoria<select value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 h-10 w-full rounded-lg border bg-white px-2 text-sm text-gray-900 dark:bg-gray-950 dark:text-white"><option value="">Wszystkie</option><option value="__none__">Brak kategorii</option>{filterOptions.data?.categories.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label className="text-xs text-gray-500">Status płatności<select value={status} onChange={(e) => setStatus(e.target.value)} className="mt-1 h-10 w-full rounded-lg border bg-white px-2 text-sm text-gray-900 dark:bg-gray-950 dark:text-white"><option value="">Wszystkie</option>{["pending", "paid", "failed", "expired", "partially_refunded", "refunded"].map((value) => <option key={value} value={value}>{paymentStatusLabel(value)}</option>)}</select></label>
          <label className="text-xs text-gray-500">Rodzaj zdarzenia<select value={eventType} onChange={(e) => setEventType(e.target.value)} className="mt-1 h-10 w-full rounded-lg border bg-white px-2 text-sm text-gray-900 dark:bg-gray-950 dark:text-white"><option value="">Wszystkie</option>{filterOptions.data?.eventTypes.map((value) => <option key={value} value={value}>{eventLabel(value)}</option>)}</select></label>
        </div>
        {bbox && <p className="mt-3 flex items-center gap-2 text-xs text-green-800 dark:text-green-300">Aktywny filtr mapy <button type="button" onClick={() => setBbox(null)} aria-label="Usuń filtr mapy"><X className="h-4 w-4" /></button></p>}
      </Panel>

      {tab === "overview" && pageContent(overviewLoading, overviewError, overview && <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {metric("Wszystkie konta", number(overview.metrics.usersTotal), undefined, () => navigate("users"))}
          {metric("Nowe rejestracje", number(overview.metrics.registrations), percent(overview.comparisons.find((x) => x.metric === "registrations")?.changePercent ?? null), () => navigate("users"))}
          {metric("Aktywne konta", number(overview.metrics.activeUsers), percent(overview.comparisons.find((x) => x.metric === "activeUsers")?.changePercent ?? null), () => navigate("activity"))}
          {metric("Aktywni: dzień / tydzień / miesiąc", `${number(overview.metrics.dau)} / ${number(overview.metrics.wau)} / ${number(overview.metrics.mau)}`, "dziennie / tygodniowo / miesięcznie", () => navigate("users"))}
          {metric("Powracające konta", number(overview.metrics.returningUsers), "aktywne w okresie i wcześniej", () => navigate("users"))}
          {metric("Nieaktywne · 30 dni", number(overview.metrics.inactiveUsers), "brak zapisanego zdarzenia", () => navigate("users"))}
          {metric("Wszystkie pinezki", number(overview.metrics.pinsTotal), undefined, () => navigate("pins"))}
          {metric("Nowe pinezki", number(overview.metrics.pinsCreated), percent(overview.comparisons.find((x) => x.metric === "pinsCreated")?.changePercent ?? null), () => navigate("pins"))}
          {metric("Transakcje", number(overview.metrics.transactions), `${number(overview.metrics.paidTransactions)} opłaconych · ${percent(overview.comparisons.find((x) => x.metric === "transactions")?.changePercent ?? null)}`, () => navigate("finance"))}
          {metric("Średnia kwota transakcji", overview.metrics.averageTransactionCentsByCurrency.length ? overview.metrics.averageTransactionCentsByCurrency.map((x: AnyRow) => money(x.cents,x.currency)).join(" · ") : "—", overview.metrics.averageTransactionCentsByCurrency.map((x: AnyRow) => `${x.currency.toUpperCase()} ${percent(x.changePercent)}`).join(" · ") || "osobno dla każdej waluty", () => navigate("finance"))}
          {metric("Płatności brutto", overview.metrics.revenueByCurrency.length ? overview.metrics.revenueByCurrency.map((x: AnyRow) => money(x.grossCents,x.currency)).join(" · ") : money(0), overview.revenueChanges.length ? overview.revenueChanges.map((x) => `${x.currency.toUpperCase()} ${percent(x.changePercent)}`).join(" · ") : "zwroty wykazywane oddzielnie", () => navigate("finance"))}
          {metric("Średnia pinezek / konto", overview.metrics.usersTotal ? (overview.metrics.pinsTotal / overview.metrics.usersTotal).toLocaleString("pl-PL", { maximumFractionDigits: 1 }) : "0", undefined, () => navigate("users"))}
        </div>
        <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
          <Panel title="Aktywność w czasie"><div className="h-72">{overview.series.length ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={overview.series} onClick={openPinBucket}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" tickFormatter={(value) => new Date(value).toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit" })} /><YAxis allowDecimals={false} /><Tooltip labelFormatter={(value) => dateTime(String(value))} /><Legend /><Area type="monotone" dataKey="pins" name="Pinezki" stroke="#15803d" fill="#22c55e" fillOpacity={0.18} /><Area type="monotone" dataKey="registrations" name="Rejestracje" stroke="#d97706" fill="#f59e0b" fillOpacity={0.15} /><Area type="monotone" dataKey="active" name="Aktywni" stroke="#2563eb" fill="#60a5fa" fillOpacity={0.12} /></AreaChart></ResponsiveContainer> : <p className="pt-20 text-center text-sm text-gray-500">Brak danych w wybranym okresie.</p>}</div><p className="mt-2 text-xs text-gray-500">Kliknięcie punktu otwiera pinezki z tego dnia lub tygodnia.</p></Panel>
          <Panel title="Najważniejsze zmiany"><ul className="space-y-3 text-sm">{overview.highlights.map((item, index) => <li key={index} className="flex gap-2"><span className="mt-0.5 text-green-700">•</span><span>{item}</span></li>)}</ul><div className="mt-5 border-t pt-4"><h3 className="mb-2 text-sm font-semibold">Sygnały do sprawdzenia</h3>{overview.anomalies.length ? <ul className="space-y-2 text-sm text-amber-800 dark:text-amber-300">{overview.anomalies.map((item) => <li key={item.kind}>⚑ {item.message}</li>)}</ul> : <p className="text-sm text-gray-500">Brak wykrytych odchyleń.</p>}</div></Panel>
        </div>
        <div className="grid gap-5 lg:grid-cols-2"><Panel title="Lejek aktywności"><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[["Rejestracje",overview.funnel.registered],["Aktywność",overview.funnel.active],["Pierwsza pinezka",overview.funnel.pinned],["Pierwsza płatność",overview.funnel.paid]].map(([label,value],index) => <div key={label} className="rounded-xl bg-gray-50 p-3 dark:bg-gray-800"><p className="text-xs text-gray-500">{label}</p><p className="mt-1 text-xl font-bold">{number(value)}</p>{index > 0 && <p className="text-xs text-gray-500">{overview.funnel.registered ? `${Math.round(Number(value)/overview.funnel.registered*100)}% rejestracji` : "brak kont w wybranym okresie"}</p>}</div>)}</div><p className="mt-3 text-xs text-gray-500">Pokazuje konta założone w wybranym okresie. Płatność jest osobnym etapem i nie oznacza, że każda pinezka prowadzi do zakupu.</p></Panel>
          <Panel title="Powroty po rejestracji"><div className="grid grid-cols-3 gap-3">{[["1 dzień",overview.retention.day1,overview.retention.day1Eligible],["7 dni",overview.retention.day7,overview.retention.day7Eligible],["30 dni",overview.retention.day30,overview.retention.day30Eligible]].map(([label,value,eligible]) => <div key={label} className="rounded-xl bg-gray-50 p-3 dark:bg-gray-800"><p className="text-xs text-gray-500">{label}</p><p className="mt-1 font-bold">{number(value)} <span className="text-xs font-normal text-gray-500">/ {number(eligible)} kont, które osiągnęły ten okres</span></p><p className="text-xs text-gray-500">{Number(eligible) ? `${Math.round(Number(value)/Number(eligible)*100)}%` : "za krótki okres obserwacji"}</p></div>)}</div><p className="mt-3 text-xs text-gray-500">Powrót oznacza co najmniej jedno zapisane zdarzenie w danym dniu UTC. Do mianownika trafiają tylko konta, które zdążyły osiągnąć dany dzień.</p></Panel></div>
        <p className="text-xs text-gray-500">Dane odświeżono: {dateTime((overview as any).generatedAt)}. Aktywność oznacza zdarzenia zapisane pod kontem Kreatora. Odbiorcy nie mają konta ani się nie logują. Wpisanie tokenu jest zliczane jako aktywność mapy, a nie konta Kreatora.</p>
      </div>)}

      {tab === "users" && <div className="space-y-5">
        {profileId && <Panel title={`Profil użytkownika · ID ${profileId}`} action={<button type="button" className="text-sm text-green-800" onClick={() => setProfileId(null)}>Zamknij profil</button>}>{pageContent(profile.loading, profile.error, profile.data && <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-4">{[["Konto",profile.data.user.name],["Rola",roleLabel(profile.data.user.role)],["Rejestracja",dateTime(profile.data.user.createdAt)],["Saldo pinezek",number(profile.data.user.pinBalance)]].map(([label,value])=><div key={label} className="rounded-xl bg-gray-50 p-3 dark:bg-gray-800"><p className="text-xs text-gray-500">{label}</p><p className="mt-1 font-semibold">{value}</p></div>)}</div><div className="grid gap-4 lg:grid-cols-3"><div><h3 className="mb-2 font-semibold">Ostatnie aktywności</h3><div className="max-h-64 space-y-2 overflow-auto">{profile.data.activity.map((row) => <p key={row.id} className="rounded-lg bg-gray-50 p-2 text-xs dark:bg-gray-800">{eventLabel(row.eventType)} · {dateTime(row.createdAt)}</p>)}</div></div><div><h3 className="mb-2 font-semibold">Pinezki</h3><div className="max-h-64 space-y-2 overflow-auto">{profile.data.pins.map((row) => <p key={row.id} className="rounded-lg bg-gray-50 p-2 text-xs dark:bg-gray-800">{row.title} · {row.category ?? "brak kategorii"} · {dateTime(row.createdAt)}</p>)}</div></div><div><h3 className="mb-2 font-semibold">Transakcje</h3><div className="max-h-64 space-y-2 overflow-auto">{profile.data.payments.map((row) => <p key={row.id} className="rounded-lg bg-gray-50 p-2 text-xs dark:bg-gray-800">{paymentStatusLabel(row.status)} · {money(row.amountCents,row.currency)} · {dateTime(row.createdAt)}</p>)}</div></div></div></div>)}</Panel>}
        <Panel title="Użytkownicy" action={<div className="flex flex-wrap items-center gap-2"><select aria-label="Sortuj użytkowników" value={userSort} onChange={(e) => setUserSort(e.target.value)} className="h-9 rounded-lg border bg-white px-2 text-sm dark:bg-gray-950"><option value="active">Najaktywniejsi</option><option value="pins">Najwięcej pinezek</option><option value="payments">Najwyższa suma płatności w PLN</option><option value="newest">Najnowsze konta</option></select><div className="relative"><Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Szukaj loginu" className="h-9 rounded-lg border bg-white pl-8 pr-3 text-sm dark:bg-gray-950" /></div></div>}>{pageContent(users.loading, users.error, users.data && <><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="text-xs uppercase text-gray-500"><tr><th className="p-2">Użytkownik</th><th className="p-2">Rola</th><th className="p-2">Pinezki</th><th className="p-2">Udział pinezek</th><th className="p-2">Aktywność</th><th className="p-2">Udział aktywności</th><th className="p-2">Transakcje</th><th className="p-2">Ostatnia aktywność</th><th className="p-2">Porównanie</th></tr></thead><tbody>{users.data.rows.map((row) => <tr key={row.id} className="border-t border-gray-100 dark:border-gray-800"><td className="p-2"><button type="button" onClick={() => setProfileId(row.id)} className="font-semibold text-green-800 underline-offset-2 hover:underline dark:text-green-300">{row.name} · ID {row.id}</button></td><td className="p-2">{roleLabel(row.role)}</td><td className="p-2">{number(row.pins)}</td><td className="p-2">{row.pinsSharePercent == null ? "—" : `${row.pinsSharePercent}%`}</td><td className="p-2">{number(row.events)}</td><td className="p-2">{row.eventsSharePercent == null ? "—" : `${row.eventsSharePercent}%`}</td><td className="p-2">{number(row.paidTransactions)} · {money(row.paymentsPlnCents, "PLN")}</td><td className="p-2">{dateTime(row.lastActivity)}</td><td className="p-2"><button type="button" className={`rounded-lg border px-2 py-1 text-xs ${compareIds.includes(row.id) ? "border-green-700 bg-green-50 text-green-900" : ""}`} onClick={() => toggleCompare(row.id)}>{compareIds.includes(row.id) ? "Wybrano" : "Porównaj"}</button></td></tr>)}</tbody></table></div><div className="flex items-center justify-between pt-3 text-sm"><span>{number(users.data.total)} kont</span><div className="flex gap-2"><button type="button" disabled={page <= 1} onClick={() => setPage((n) => n - 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Wstecz</button><button type="button" disabled={page * 25 >= users.data.total} onClick={() => setPage((n) => n + 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Dalej</button></div></div></>)}</Panel>
        {compareIds.length === 2 && users.data && <Panel title="Porównanie dwóch użytkowników"><div className="h-64"><ResponsiveContainer width="100%" height="100%"><BarChart data={users.data.rows.filter((row) => compareIds.includes(row.id))}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="name" /><YAxis allowDecimals={false} /><Tooltip /><Legend /><Bar dataKey="events" name="Zdarzenia" fill="#15803d" /><Bar dataKey="pins" name="Pinezki" fill="#f59e0b" /><Bar dataKey="paidTransactions" name="Opłacone transakcje" fill="#2563eb" /></BarChart></ResponsiveContainer></div></Panel>}
      </div>}

      {tab === "pins" && pageContent(pins.loading, pins.error, pins.data && <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]"><Panel title={`Mapa pinezek · ${number(pins.data.total)}`}><PinMap rows={pins.data.mapPoints} onBounds={selectUserFromMap} /></Panel><div className="space-y-5"><Panel title="Ranking autorów"><div className="space-y-2">{pins.data.authors.length ? pins.data.authors.map((row) => <button type="button" key={row.id} className="flex w-full justify-between rounded-lg bg-gray-50 p-3 text-left text-sm hover:bg-green-50 dark:bg-gray-800 dark:hover:bg-green-950" onClick={() => setSelectedUser(String(row.id))}><span>{row.name}</span><strong>{number(row.pins)} · {row.share}%</strong></button>) : <p className="text-sm text-gray-500">Brak pinezek w okresie.</p>}</div></Panel><Panel title="Utworzone pinezki w czasie"><div className="h-56"><ResponsiveContainer width="100%" height="100%"><AreaChart data={pins.data.series}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" hide /><YAxis allowDecimals={false} /><Tooltip /><Area type="monotone" dataKey="pins" stroke="#15803d" fill="#22c55e" fillOpacity={0.18} /></AreaChart></ResponsiveContainer></div><p className="text-xs text-gray-500">{pins.data.categoryHistoryNote}</p></Panel></div><Panel title="Lista pinezek"><div className="max-h-[540px] overflow-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead><tr className="text-xs text-gray-500"><th className="p-2">Pinezka</th><th className="p-2">Kreator</th><th className="p-2">Kategoria</th><th className="p-2">Współrzędne</th><th className="p-2">Utworzono</th></tr></thead><tbody>{pins.data.rows.map((row) => <tr key={row.id} className="border-t"><td className="p-2">{row.title}</td><td className="p-2">{row.ownerName} · {row.ownerUserId}</td><td className="p-2">{row.category ?? "—"}</td><td className="p-2">{Number(row.lat).toFixed(4)}, {Number(row.lng).toFixed(4)}</td><td className="p-2">{dateTime(row.createdAt)}</td></tr>)}</tbody></table></div><div className="mt-3 flex justify-end gap-2"><button type="button" disabled={page <= 1} onClick={() => setPage((n) => n - 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Wstecz</button><button type="button" disabled={page * 25 >= pins.data.total} onClick={() => setPage((n) => n + 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Dalej</button></div></Panel></div>)}

      {tab === "finance" && pageContent(finance.loading, finance.error, finance.data && <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{finance.data.totals.map((row) => <div key={row.currency} className="rounded-2xl border bg-white p-4 dark:bg-gray-900"><p className="text-xs text-gray-500">Waluta: {row.currency.toUpperCase()}</p><p className="mt-2 text-xl font-bold">Brutto {money(row.gross_cents,row.currency)}</p><p className="mt-1 text-sm">Zwroty w okresie {money(row.current_refunded_cents,row.currency)}</p><p className="text-sm">Netto w okresie {money(row.net_cents,row.currency)}</p><p className="mt-2 text-xs text-gray-500">{number(row.transactions)} transakcji · {number(row.payers)} płacących Kreatorów · średnia kwota płatności {money(row.average_cents,row.currency)}</p></div>)}</div><div className="grid gap-5 lg:grid-cols-2">{[...new Set(finance.data.series.map((row) => row.currency))].map((currency) => <Panel key={currency} title={`Wartość opłaconych transakcji · ${currency.toUpperCase()}`}><div className="h-64">{finance.data!.series.some((row) => row.currency === currency) ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={finance.data!.series.filter((row) => row.currency === currency)}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="date" tickFormatter={(value) => new Date(value).toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit" })} /><YAxis tickFormatter={(value) => money(Number(value), currency).replace(/[\s\u00a0]/g, "")} /><Tooltip labelFormatter={(value) => dateTime(String(value))} formatter={(value) => money(Number(value), currency)} /><Area type="monotone" dataKey="grossCents" name="Kwota brutto" stroke="#15803d" fill="#22c55e" fillOpacity={0.18} /></AreaChart></ResponsiveContainer> : <p className="pt-20 text-center text-sm text-gray-500">Brak opłaconych transakcji w okresie.</p>}</div><p className="text-xs text-gray-500">{finance.data!.currencyNote}</p></Panel>)}</div><Panel title="Zwroty w wybranym okresie">{finance.data.refundsInRange.length ? finance.data.refundsInRange.map((row) => <span key={row.currency} className="mr-5 font-semibold">{row.currency?.toUpperCase()}: {money(row.cents,row.currency)}</span>) : <span className="text-sm text-gray-500">Brak zarejestrowanych zwrotów.</span>}<p className="mt-2 text-xs text-gray-500">{finance.data.currencyNote}</p></Panel><div className="grid gap-5 lg:grid-cols-2"><Panel title="Ranking płatności"><div className="space-y-2">{finance.data.payers.map((row) => <button type="button" key={`${row.id}-${row.currency}`} onClick={() => { setProfileId(row.id); setTab("users"); }} className="flex w-full justify-between rounded-lg bg-gray-50 p-3 text-left text-sm dark:bg-gray-800"><span>{row.name} · {row.currency.toUpperCase()}</span><strong>{money(row.gross_cents,row.currency)} · {row.share}% udział</strong></button>)}</div></Panel><Panel title="Historia transakcji"><div className="max-h-[500px] overflow-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead><tr className="text-xs text-gray-500"><th className="p-2">Użytkownik</th><th className="p-2">Pakiet</th><th className="p-2">Kwota</th><th className="p-2">Status</th><th className="p-2">Data</th></tr></thead><tbody>{finance.data.rows.map((row) => <tr key={row.id} className="border-t"><td className="p-2">{row.userName} · {row.userId}</td><td className="p-2">{packageLabel(row.packageId)} · {number(row.pins)} pinezek</td><td className="p-2">{money(row.amountCents,row.currency)}</td><td className="p-2">{paymentStatusLabel(row.status)}{row.refundAmountCents ? ` · zwrot ${money(row.refundAmountCents,row.currency)}` : ""}</td><td className="p-2">{dateTime(row.paidAt ?? row.createdAt)}</td></tr>)}</tbody></table></div><div className="mt-3 flex justify-end gap-2"><button type="button" disabled={page <= 1} onClick={() => setPage((n) => n - 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Wstecz</button><button type="button" disabled={page * 25 >= finance.data.total} onClick={() => setPage((n) => n + 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Dalej</button></div></Panel></div></div>)}

      {tab === "activity" && pageContent(activity.loading, activity.error, activity.data && <Panel title={`Dziennik zdarzeń · ${number(activity.data.total)}`}><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="text-xs uppercase text-gray-500"><tr><th className="p-2">Data</th><th className="p-2">Zdarzenie</th><th className="p-2">Użytkownik</th><th className="p-2">Konto / obiekt</th><th className="p-2">Szczegóły</th></tr></thead><tbody>{activity.data.rows.map((row) => <tr key={row.id} className="border-t"><td className="p-2">{dateTime(row.createdAt)}</td><td className="p-2">{eventLabel(row.eventType)}</td><td className="p-2">{activityActorLabel(row)} {row.actorUserId ? `· ${row.actorUserId}` : ""}</td><td className="p-2">{row.tenantName ?? "—"} {row.tenantUserId ? `· ${row.tenantUserId}` : ""} {row.details?.markerId ? `· pinezka ${row.details.markerId}` : ""}</td><td className="max-w-sm truncate p-2" title={JSON.stringify(row.details)}>{Object.entries(row.details ?? {}).map(([key,value]) => `${key}: ${String(value)}`).join(" · ") || "—"}</td></tr>)}</tbody></table></div><p className="mt-3 text-xs text-gray-500">{activity.data.historyNote}</p><div className="mt-3 flex justify-end gap-2"><button type="button" disabled={page <= 1} onClick={() => setPage((n) => n - 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Wstecz</button><button type="button" disabled={page * 25 >= activity.data.total} onClick={() => setPage((n) => n + 1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Dalej</button></div></Panel>)}

      {tab === "reports" && <div className="grid gap-5 md:grid-cols-2">{[["users","Użytkownicy","Konta i zdarzenia z wybranego okresu."],["pins","Pinezki","Twórcy, kategorie i współrzędne pinezek."],["payments","Transakcje","Kwoty, zwroty i statusy, bez identyfikatorów Stripe."],["activity","Aktywność","Chronologiczne zdarzenia, bez danych sekretów."]].map(([dataset,title,description])=><Panel key={dataset} title={title} action={<Download className="h-4 w-4 text-green-700" />}><p className="mb-4 text-sm text-gray-500">{description}</p><button type="button" onClick={() => void exportCsv(dataset)} className="rounded-lg bg-green-800 px-4 py-2 text-sm font-semibold text-white hover:bg-green-900">Pobierz CSV · maks. 5000 wierszy</button></Panel>)}{exportError && <p role="alert" className="text-sm text-red-700">{exportError}</p>}</div>}
    </div>
  </main>;
}

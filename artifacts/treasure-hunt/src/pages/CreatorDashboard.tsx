import { useEffect, useMemo, useRef, useState } from "react";
import type { Marker, Stats } from "@workspace/api-client-react";
import { FIRST_PURCHASE_BONUS_PINS } from "@workspace/api-zod/pin-packages";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import ControlPanel from "@/pages/ControlPanel";
import PodchodyOrganizer from "@/pages/PodchodyOrganizer";
import { formatActivationDate, formatCodeTimer, safePopupImageUrl } from "@/pages/map-shared";
import { BarChart3, ChevronDown, ChevronUp, Clock, Copy, Eye, LogOut, MapPin, Moon, Plus, RefreshCcw, Search, Shield, Sun, Trash2, X } from "lucide-react";

type PickedPoint = { index: number; lat: number; lng: number; nonce: number };

type CreatorDashboardProps = {
  user: { id: number; name: string; role: string; canAccessAnalytics?: boolean } | null;
  layoutPreview?: boolean;
  isMobile: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onLogout: () => void;
  markers: Marker[];
  stats?: Stats;
  saved: boolean;
  selectedMarkerId: number | null;
  onVisibleMarkers: (markers: Marker[]) => void;
  onFly: (lat: number, lng: number, id: number) => void;
  onDelete: (id: number) => void;
  onCopy: (code: string) => void;
  onRefresh: () => void;
  onStartAdd: () => void;
  pinBalance: number | null;
  firstPurchaseBonusGranted: boolean;
  paymentPending: boolean;
  checkoutError: string | null;
  onOpenPackages: () => void;
  picked: PickedPoint | null;
  onRequestPick: (index: number) => void;
  onNeedPins: () => void;
  onPublished: (pinBalance: number, charged: boolean) => void;
};

function MarkerRow({
  marker, onFly, onDelete, onCopy, onPreview, isSelected,
}: {
  marker: Marker;
  onFly: (lat: number, lng: number, id: number) => void;
  onDelete: (id: number) => void;
  onCopy: (code: string) => void;
  onPreview: (marker: Marker) => void;
  isSelected: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (isSelected) rowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [isSelected]);
  const notStarted = marker.expiresAt === null;
  const remaining = marker.expiresAt ? new Date(marker.expiresAt).getTime() - now : 0;
  const isExpired = !notStarted && remaining <= 0;
  return (
    <div ref={rowRef} className={`cursor-pointer rounded-md p-3 text-sm ${isSelected ? "border-2 border-green-600 bg-white shadow-md dark:bg-gray-700" : isExpired ? "border bg-gray-50 opacity-60 dark:bg-gray-700/50" : "border bg-white hover:border-green-300 dark:border-gray-600 dark:bg-gray-700"}`} onClick={() => onFly(marker.lat, marker.lng, marker.id)}>
      <div className="mb-1 flex items-start justify-between gap-1">
        <span className={`min-w-0 flex-1 truncate font-semibold ${isExpired ? "text-gray-500" : "text-green-900 dark:text-green-400"}`}>{marker.title}</span>
        <div className="flex shrink-0 items-center">
          {marker.hasImage && (
            <Button variant="ghost" size="icon" className="h-6 w-6 text-blue-400" title="Podgląd zdjęcia" onClick={(event) => { event.stopPropagation(); onPreview(marker); }}>
              <Eye className="h-3 w-3" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-6 w-6 text-red-400" title="Usuń skarb" onClick={(event) => { event.stopPropagation(); onDelete(marker.id); }}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <code className={`rounded px-2 py-0.5 font-mono text-xs font-bold tracking-widest ${isExpired ? "bg-gray-200 text-gray-400 line-through" : "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300"}`}>{marker.code}</code>
        <Button variant="ghost" size="icon" className="h-6 w-6" title="Kopiuj kod" onClick={(event) => { event.stopPropagation(); onCopy(marker.code); }}><Copy className="h-3.5 w-3.5" /></Button>
        <span className={`flex items-center gap-1 font-mono text-xs font-semibold ${notStarted ? "text-gray-500" : isExpired ? "text-gray-400" : "text-red-500"}`}>
          <Clock className="h-3 w-3" />
          {notStarted ? "Nieaktywny (60:00)" : isExpired ? "Wygasły" : formatCodeTimer(remaining)}
        </span>
        <span className="ml-auto font-mono text-[11px] text-gray-400">{marker.activatedAt ? formatActivationDate(marker.activatedAt) : "—"}</span>
      </div>
    </div>
  );
}

export default function CreatorDashboard(props: CreatorDashboardProps) {
  const {
    user, layoutPreview = false, isMobile, collapsed, onCollapsedChange, theme, onToggleTheme, onLogout,
    markers, stats, saved, selectedMarkerId, onVisibleMarkers, onFly, onDelete, onCopy, onRefresh, onStartAdd,
    pinBalance, firstPurchaseBonusGranted, paymentPending, checkoutError, onOpenPackages,
    picked, onRequestPick, onNeedPins, onPublished,
  } = props;
  const isCreator = user?.role === "admin";
  const hasUnlimitedPins = user?.role === "master_admin" || user?.role === "moderator";
  const canManageAccounts = user?.role === "moderator" || user?.role === "master_admin";
  const [tab, setTab] = useState<"skarby" | "podchody">("skarby");
  const [statsOpen, setStatsOpen] = useState(true);
  const [statsFilter, setStatsFilter] = useState<"all" | "active" | "expired">("all");
  const [markerSearch, setMarkerSearch] = useState("");
  const [markerSort, setMarkerSort] = useState<"newest" | "name">("newest");
  const [preview, setPreview] = useState<Marker | null>(null);

  const filteredMarkers = useMemo(() => {
    const now = Date.now();
    const query = markerSearch.trim().toLocaleLowerCase("pl-PL");
    return markers.filter((marker) => {
      const expired = marker.expiresAt !== null && new Date(marker.expiresAt).getTime() <= now;
      const matchesStatus = statsFilter === "all" || (statsFilter === "active" ? !expired : expired);
      const matchesSearch = !query || marker.title.toLocaleLowerCase("pl-PL").includes(query) || marker.code.toLocaleLowerCase("pl-PL").includes(query);
      return matchesStatus && matchesSearch;
    }).sort((a, b) => markerSort === "name" ? a.title.localeCompare(b.title, "pl") : b.createdAt.localeCompare(a.createdAt));
  }, [markers, statsFilter, markerSearch, markerSort]);

  useEffect(() => { onVisibleMarkers(filteredMarkers); }, [filteredMarkers, onVisibleMarkers]);

  const openPreview = async (marker: Marker) => {
    if (marker.hasImage && !marker.imageUrl && marker.id > 0) {
      try {
        const response = await fetch(`/api/markers/${marker.id}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
        if (response.ok) {
          setPreview(await response.json() as Marker);
          return;
        }
      } catch {
        // Show the marker text even when the photo request fails.
      }
    }
    setPreview(marker);
  };

  return (
    <>
      {isMobile && !collapsed && <button type="button" aria-label="Zamknij panel" onClick={() => onCollapsedChange(true)} className="absolute inset-0 z-[1040] bg-black/30" />}
      <aside className={`absolute z-[1050] flex flex-col overflow-hidden border-gray-200 bg-[#fafbfc] shadow-xl transition-transform duration-300 dark:border-gray-700 dark:bg-gray-900 ${isMobile ? `inset-x-0 bottom-0 top-auto h-[min(78dvh,680px)] rounded-t-2xl border-t ${collapsed ? "translate-y-[calc(100%-4.25rem)]" : "translate-y-0"}` : "bottom-0 right-0 top-0 translate-y-0 border-l"}`} style={{ width: isMobile ? "100%" : "clamp(360px, 30vw, 420px)" }}>
        {isMobile && (
          <button type="button" aria-expanded={!collapsed} onClick={() => onCollapsedChange(!collapsed)} className="flex h-9 shrink-0 items-center justify-center gap-2 border-b bg-white text-xs font-semibold dark:bg-gray-800">
            <span className="h-1 w-10 rounded-full bg-gray-300" />
            Panel
            {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        )}
        <div className="flex h-12 shrink-0 items-center justify-between border-b bg-white px-4 dark:bg-gray-800">
          <div className="flex min-w-0 items-center gap-2">
            <Shield className="h-4 w-4 shrink-0 text-green-700" />
            <span className="truncate text-sm font-semibold">{user?.name ?? "admin"}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="icon" onClick={onToggleTheme} title={theme === "dark" ? "Tryb jasny" : "Tryb ciemny"} className="h-8 w-8">{theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</Button>
            {user?.canAccessAnalytics && <a href="/analytics" className="rounded-md px-2 py-1.5 text-xs font-semibold text-green-800 dark:text-green-300">Analityka</a>}
            <Button variant="ghost" size="sm" onClick={onLogout} className="h-8 px-2 text-red-600"><LogOut className="mr-1 h-3.5 w-3.5" /><span className="text-xs">Wyloguj</span></Button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
          {user && !layoutPreview && (hasUnlimitedPins || isCreator) && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
              {hasUnlimitedPins ? <>Pinezki: <strong>bez limitu</strong></> : (
                <>
                  <div>Pozostałe pinezki: <strong>{pinBalance ?? "…"}</strong></div>
                  <span className="mt-1 block text-xs">1 pinezka = 1 skarb albo 1 opublikowana gra. Zakup jest jednorazowy.</span>
                  {!firstPurchaseBonusGranted && <span className="mt-1 block text-xs font-semibold">Przy pierwszym zakupie otrzymasz dodatkowe {FIRST_PURCHASE_BONUS_PINS} pinezek.</span>}
                  {paymentPending && <p role="status" className="mt-2 text-xs font-medium">Potwierdzamy płatność. Saldo odświeży się automatycznie.</p>}
                  {checkoutError && <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">{checkoutError}</p>}
                  <Button type="button" size="sm" className="mt-2 h-8 bg-green-700 hover:bg-green-800" onClick={onOpenPackages}>Dokup pinezki</Button>
                  <a href="/cennik.html" className="mt-2 block text-xs font-medium text-green-800 underline dark:text-green-300">Szczegółowy cennik dla Kreatorów</a>
                </>
              )}
            </div>
          )}
          {canManageAccounts && !layoutPreview && user && <ControlPanel user={user} />}
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant={tab === "skarby" ? "default" : "outline"} className={tab === "skarby" ? "bg-green-700" : ""} onClick={() => setTab("skarby")}>Skarby</Button>
            <Button type="button" variant={tab === "podchody" ? "default" : "outline"} className={tab === "podchody" ? "bg-green-700" : ""} onClick={() => setTab("podchody")}>Podchody</Button>
          </div>
          {tab === "podchody" ? (
            <PodchodyOrganizer layoutPreview={layoutPreview} hasUnlimitedPins={hasUnlimitedPins} picked={picked} onRequestPick={onRequestPick} onNeedPins={onNeedPins} onPublished={onPublished} />
          ) : (
            <>
              <section className="rounded-xl border bg-white shadow-sm dark:bg-gray-800">
                <button type="button" onClick={() => setStatsOpen((open) => !open)} className="flex w-full items-center justify-between px-4 py-3">
                  <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider"><BarChart3 className="h-4 w-4 text-green-700" />Statystyki</span>
                  {statsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
                {statsOpen && stats && (
                  <div className="grid grid-cols-2 gap-2 px-4 pb-3">
                    <button type="button" onClick={() => setStatsFilter((filter) => filter === "active" ? "all" : "active")} className={`rounded-xl border px-3 py-2 text-left ${statsFilter === "active" ? "ring-2 ring-green-500" : ""}`}>
                      <span className="text-[11px] text-gray-500">Aktywne</span>
                      <span className="block text-2xl font-bold">{stats.activeMarkers}</span>
                    </button>
                    <button type="button" onClick={() => setStatsFilter((filter) => filter === "expired" ? "all" : "expired")} className={`rounded-xl border px-3 py-2 text-left ${statsFilter === "expired" ? "ring-2 ring-red-400" : ""}`}>
                      <span className="text-[11px] text-gray-500">Wygasłe</span>
                      <span className="block text-2xl font-bold">{stats.expiredMarkers}</span>
                    </button>
                  </div>
                )}
              </section>
              <section className="rounded-xl border bg-white shadow-sm dark:bg-gray-800">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider"><MapPin className="h-4 w-4 text-green-700" />Skarby ({filteredMarkers.length}{statsFilter !== "all" ? `/${markers.length}` : ""})</span>
                  <div className="flex items-center gap-1">
                    {saved && <span className="text-[10px] font-bold text-green-600">Zapisano</span>}
                    <Button type="button" size="sm" onClick={onStartAdd} className="h-8 bg-green-700 px-2 text-xs text-white"><Plus className="mr-1 h-3.5 w-3.5" />Dodaj</Button>
                    <button type="button" title="Odśwież" onClick={onRefresh} className="inline-flex h-7 w-7 items-center justify-center rounded-lg"><RefreshCcw className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
                <div className="flex flex-col gap-2 p-3">
                  <div className="flex gap-2">
                    <div className="relative min-w-0 flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                      <Input value={markerSearch} onChange={(event) => setMarkerSearch(event.target.value)} placeholder="Szukaj skarbów" aria-label="Szukaj skarbów po nazwie lub kodzie" className="h-10 bg-gray-50 pl-9 text-sm dark:bg-gray-700" />
                      {markerSearch && <button type="button" aria-label="Wyczyść wyszukiwanie" onClick={() => setMarkerSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2"><X className="h-4 w-4" /></button>}
                    </div>
                    <select aria-label="Sortuj skarby" value={markerSort} onChange={(event) => setMarkerSort(event.target.value as "newest" | "name")} className="h-10 max-w-[112px] rounded-lg border bg-gray-50 px-2 text-xs dark:bg-gray-700">
                      <option value="newest">Najnowsze</option>
                      <option value="name">Nazwa A–Z</option>
                    </select>
                  </div>
                  {filteredMarkers.map((marker) => (
                    <MarkerRow key={marker.id} marker={marker} onFly={onFly} onDelete={onDelete} onCopy={onCopy} onPreview={openPreview} isSelected={selectedMarkerId === marker.id} />
                  ))}
                  {filteredMarkers.length === 0 && <div className="p-4 text-center text-sm text-gray-500">{markers.length === 0 ? "Brak skarbów. Wybierz „Dodaj skarb”, aby rozpocząć." : "Brak skarbów dla tego widoku."}</div>}
                </div>
              </section>
            </>
          )}
        </div>
      </aside>
      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="text-green-900">{preview?.title}</DialogTitle></DialogHeader>
          {preview && safePopupImageUrl(preview.imageUrl) ? (
            <img src={safePopupImageUrl(preview.imageUrl) ?? undefined} alt={preview.title} className="max-h-72 w-full rounded-md object-contain" />
          ) : (
            <div className="flex h-32 items-center justify-center rounded-md border text-sm italic text-gray-400">Brak zdjęcia</div>
          )}
          <p className="text-xs italic text-gray-500">{preview?.description}</p>
        </DialogContent>
      </Dialog>
    </>
  );
}

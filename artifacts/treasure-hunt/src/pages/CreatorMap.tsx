import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Marker } from "@workspace/api-client-react";
import type { GuestData } from "@/App";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Clock, Loader2, LogOut, Moon, Plus, Search, Sun } from "lucide-react";
import {
  adminPinHtml,
  bindPopupNavigation,
  createIcon,
  escapePopupHtml,
  expiredPinHtml,
  formatCodeTimer,
  redPinHtml,
  safePopupImageUrl,
  searchPinHtml,
} from "@/pages/map-shared";

export type CreatorMapHandle = {
  flyTo: (lat: number, lng: number, zoom?: number) => void;
  openPopup: (id: number) => void;
};

type CreatorMapProps = {
  isAdmin: boolean;
  theme: "light" | "dark";
  guestData: GuestData | null;
  markers: Marker[];
  picking: boolean;
  pickingLabel: string;
  onCancelPick: () => void;
  onPick: (lat: number, lng: number) => void;
  onMarkerClick: (id: number) => void;
  onStartAdd: () => void;
  onToggleTheme: () => void;
  onLogout: () => void;
  loginMsg: string | null;
};

function guestPopup(guest: GuestData, isDark: boolean): string {
  const imageUrl = safePopupImageUrl(guest.imageUrl);
  return `
    <div style="padding:8px;min-width:230px;background:${isDark ? "#1f2937" : "#ffffff"};border-radius:4px">
      ${imageUrl ? `<img src="${escapePopupHtml(imageUrl)}" alt="" style="width:100%;height:96px;object-fit:cover;border-radius:4px;margin-bottom:8px"/>` : ""}
      <h3 style="font-weight:700;font-size:15px;color:${isDark ? "#fbbf24" : "#d97706"}">${escapePopupHtml(guest.markerTitle)}</h3>
      <p style="font-size:12px;color:${isDark ? "#d1d5db" : "#374151"};margin-top:4px;font-style:italic">💡 ${escapePopupHtml(guest.markerDescription)}</p>
      <span style="display:inline-block;margin-top:8px;padding:2px 8px;background:${isDark ? "#374151" : "#fef3c7"};color:${isDark ? "#fde68a" : "#92400e"};border-radius:9999px;font-size:11px;font-weight:700">Szukaj skarbu w tym miejscu</span>
      <button type="button" data-nav-lat="${guest.lat}" data-nav-lng="${guest.lng}" style="margin-top:10px;width:100%;background:#2563eb;color:#fff;font-size:13px;font-weight:600;padding:7px 10px;border:none;border-radius:6px;cursor:pointer">Nawiguj</button>
    </div>`;
}

function adminPopup(marker: Marker, isDark: boolean, imageUrl: string | null): string {
  const expired = marker.expiresAt !== null && new Date(marker.expiresAt) < new Date();
  const safeImage = safePopupImageUrl(imageUrl);
  return `
    <div style="padding:8px;min-width:200px;background:${isDark ? "#1f2937" : "#ffffff"};border-radius:4px">
      ${safeImage ? `<img src="${escapePopupHtml(safeImage)}" alt="" style="width:100%;height:80px;object-fit:cover;border-radius:4px;margin-bottom:6px"/>` : ""}
      <h3 style="font-weight:700;font-size:14px;color:${expired ? (isDark ? "#6b7280" : "#9ca3af") : (isDark ? "#6ee7b7" : "#166534")}">${escapePopupHtml(marker.title)}${expired ? " (Wygasły)" : ""}</h3>
      <p style="font-size:12px;color:${isDark ? "#9ca3af" : "#6b7280"};margin-top:4px">${escapePopupHtml(marker.description)}</p>
      <div style="margin-top:8px;background:${isDark ? "#374151" : "#f3f4f6"};padding:6px;border-radius:4px;text-align:center">
        <code style="font-family:monospace;font-weight:700;letter-spacing:0.1em;color:${expired ? (isDark ? "#6b7280" : "#9ca3af") : (isDark ? "#6ee7b7" : "#15803d")};${expired ? "text-decoration:line-through" : ""}">${escapePopupHtml(marker.code)}</code>
      </div>
    </div>`;
}

const CreatorMap = forwardRef<CreatorMapHandle, CreatorMapProps>(function CreatorMap({
  isAdmin, theme, guestData, markers, picking, pickingLabel, onCancelPick, onPick, onMarkerClick, onStartAdd, onToggleTheme, onLogout, loginMsg,
}, ref) {
  const { toast } = useToast();
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const markersRef = useRef<Record<number, L.Marker>>({});
  const searchMarkerRef = useRef<L.Marker | null>(null);
  const themeRef = useRef(theme);
  const pickingRef = useRef(picking);
  const onPickRef = useRef(onPick);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [guestNow, setGuestNow] = useState(Date.now());
  const imageCache = useRef<Record<number, string>>({});

  useEffect(() => { themeRef.current = theme; }, [theme]);
  useEffect(() => { pickingRef.current = picking; }, [picking]);
  useEffect(() => { onPickRef.current = onPick; }, [onPick]);

  useImperativeHandle(ref, () => ({
    flyTo(lat, lng, zoom = 18) { mapRef.current?.flyTo([lat, lng], zoom); },
    openPopup(id) { window.setTimeout(() => markersRef.current[id]?.openPopup(), 500); },
  }), []);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const map = L.map(mapContainer.current).setView([53.4285, 14.5528], 14);
    mapRef.current = map;
    bindPopupNavigation(map);
    map.on("click", (event) => {
      if (!pickingRef.current) return;
      onPickRef.current(event.latlng.lat, event.latlng.lng);
    });
    return () => {
      tileLayerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [isAdmin]);

  useEffect(() => {
    if (!mapRef.current) return;
    tileLayerRef.current?.remove();
    tileLayerRef.current = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(mapRef.current);
  }, [theme, isAdmin]);

  useEffect(() => {
    if (!mapRef.current || !guestData) return;
    const marker = L.marker([guestData.lat, guestData.lng], { icon: createIcon(redPinHtml) })
      .addTo(mapRef.current)
      .bindPopup(guestPopup(guestData, themeRef.current === "dark"));
    markersRef.current[guestData.markerId] = marker;
    mapRef.current.flyTo([guestData.lat, guestData.lng], 16);
    marker.openPopup();
    return () => {
      marker.remove();
      delete markersRef.current[guestData.markerId];
    };
  }, [guestData?.markerId]);

  useEffect(() => {
    const marker = guestData ? markersRef.current[guestData.markerId] : undefined;
    marker?.setPopupContent(guestData ? guestPopup(guestData, theme === "dark") : "");
  }, [theme, guestData]);

  useEffect(() => {
    if (!mapRef.current || !isAdmin) return;
    Object.values(markersRef.current).forEach((marker) => marker.remove());
    markersRef.current = {};
    const dark = theme === "dark";
    for (const marker of markers) {
      const expired = marker.expiresAt !== null && new Date(marker.expiresAt) < new Date();
      const counting = marker.expiresAt !== null && !expired;
      const pin = L.marker([marker.lat, marker.lng], {
        icon: createIcon(expired ? expiredPinHtml : counting ? redPinHtml : adminPinHtml),
        opacity: expired ? 0.55 : 1,
      }).addTo(mapRef.current).bindPopup(adminPopup(marker, dark, imageCache.current[marker.id] ?? marker.imageUrl));
      pin.on("click", () => {
        onMarkerClick(marker.id);
        if (!marker.hasImage || imageCache.current[marker.id] || marker.imageUrl) return;
        void fetch(`/api/markers/${marker.id}`, { credentials: "same-origin", headers: { Accept: "application/json" } })
          .then((response) => response.ok ? response.json() as Promise<Marker> : null)
          .then((detail) => {
            if (!detail?.imageUrl) return;
            imageCache.current[marker.id] = detail.imageUrl;
            pin.setPopupContent(adminPopup(marker, themeRef.current === "dark", detail.imageUrl));
          })
          .catch(() => undefined);
      });
      markersRef.current[marker.id] = pin;
    }
  }, [isAdmin, markers, theme, onMarkerClick]);

  useEffect(() => {
    if (!guestData) return;
    const id = window.setInterval(() => setGuestNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [guestData]);

  const handleAddressSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!searchQuery.trim() || !mapRef.current) return;
    setSearching(true);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=pl&q=${encodeURIComponent(`${searchQuery}, Szczecin`)}`;
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      const data = await response.json();
      if (!Array.isArray(data) || !data.length) {
        toast({ variant: "destructive", title: "Nie znaleziono", description: "Brak wyników dla tej ulicy." });
        return;
      }
      const lat = Number.parseFloat(data[0].lat);
      const lng = Number.parseFloat(data[0].lon);
      mapRef.current.flyTo([lat, lng], 16);
      searchMarkerRef.current?.remove();
      searchMarkerRef.current = L.marker([lat, lng], { icon: createIcon(searchPinHtml) })
        .addTo(mapRef.current)
        .bindPopup(`<div style="padding:4px"><b>${escapePopupHtml(String(data[0].display_name ?? ""))}</b></div>`)
        .openPopup();
    } catch {
      toast({ variant: "destructive", title: "Błąd", description: "Nie udało się wyszukać adresu." });
    } finally {
      setSearching(false);
    }
  };

  const guestRemaining = guestData ? new Date(guestData.markerExpiresAt).getTime() - guestNow : 0;

  return (
    <div className="relative z-0 min-h-0 flex-1 bg-slate-100">
      <div ref={mapContainer} className="absolute inset-0 h-full w-full" />
      {isAdmin && (
        <Button type="button" onClick={onStartAdd} className="absolute left-14 top-3 z-[1200] h-10 rounded-xl bg-green-700 px-3.5 text-sm font-semibold text-white shadow-lg hover:bg-green-800">
          <Plus className="mr-1.5 h-4 w-4" />
          Dodaj skarb
        </Button>
      )}
      {picking && (
        <div className="absolute left-1/2 top-16 z-[1000] flex w-[min(92vw,390px)] -translate-x-1/2 items-center justify-between gap-3 rounded-xl border border-green-200 bg-white/95 px-4 py-3 text-sm text-green-950 shadow-lg backdrop-blur dark:border-green-800 dark:bg-gray-900/95 dark:text-green-100">
          <span>{pickingLabel}</span>
          <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 px-2" onClick={onCancelPick}>Anuluj</Button>
        </div>
      )}
      {isAdmin && (
        <form onSubmit={handleAddressSearch} className="absolute bottom-4 left-1/2 z-[1000] flex w-[min(92vw,360px)] -translate-x-1/2 items-center gap-2 rounded-lg border border-green-100 bg-white/95 p-2 shadow-lg backdrop-blur dark:border-gray-600 dark:bg-gray-800/95">
          <Input placeholder="Szukaj ulicy w Szczecinie..." value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} className="h-8 border-none text-sm focus-visible:ring-1 focus-visible:ring-green-500" />
          <Button type="submit" size="icon" className="h-8 w-8 bg-green-700 hover:bg-green-800" disabled={searching}>
            {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          </Button>
        </form>
      )}
      {!isAdmin && (
        <div className="absolute right-3 top-3 z-[1100] flex items-center gap-2">
          <button type="button" onClick={onToggleTheme} title={theme === "dark" ? "Tryb jasny" : "Tryb ciemny"} className="flex h-10 w-10 items-center justify-center rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-600 dark:bg-gray-800">
            {theme === "dark" ? <Sun className="h-4 w-4 text-amber-500" /> : <Moon className="h-4 w-4 text-gray-600" />}
          </button>
          <button type="button" onClick={onLogout} title="Wróć" className="flex h-10 w-10 items-center justify-center rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-600 dark:bg-gray-800">
            <LogOut className="h-4 w-4 text-red-500" />
          </button>
        </div>
      )}
      {loginMsg && (
        <div className="pointer-events-none absolute bottom-20 left-1/2 z-[2000] -translate-x-1/2">
          <div className="whitespace-nowrap rounded-2xl border border-green-100 bg-white/90 px-5 py-2.5 text-[13px] font-medium text-green-900 shadow-lg dark:border-green-900 dark:bg-gray-800/90 dark:text-green-300">{loginMsg}</div>
        </div>
      )}
      {guestData && (
        <div className="pointer-events-none absolute bottom-6 left-1/2 z-[999] -translate-x-1/2">
          <div className={`flex items-center gap-2 rounded-full border px-4 py-2 font-mono text-sm font-bold shadow-lg ${guestRemaining <= 0 ? "border-gray-200 bg-gray-100 text-gray-500" : "border-red-200 bg-white/90 text-red-600 dark:border-red-800 dark:bg-gray-800/90 dark:text-red-400"}`}>
            <Clock className="h-4 w-4" />
            {guestRemaining <= 0 ? "00:00" : formatCodeTimer(guestRemaining)}
          </div>
        </div>
      )}
    </div>
  );
});

export default CreatorMap;

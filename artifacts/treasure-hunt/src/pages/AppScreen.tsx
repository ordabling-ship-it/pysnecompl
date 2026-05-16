import { useEffect, useRef, useState, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  useListMarkers,
  useGetStats,
  useCreateMarker,
  useDeleteMarker,
  getListMarkersQueryKey,
  getGetStatsQueryKey,
} from "@workspace/api-client-react";
import type { GuestData } from "@/App";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  LogOut, Search, Shield, User, Image as ImageIcon, Trash2, RefreshCcw,
  BarChart3, List, Loader2, Copy, Eye, X, ChevronRight, ChevronLeft, Clock,
} from "lucide-react";

// ─────────────────────────────────────────────
// Map icon SVGs
// ─────────────────────────────────────────────
const goldCoinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#f59e0b" stroke="#b45309" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><circle cx="12" cy="12" r="10"/><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
const adminPinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#22c55e" stroke="#166534" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
const expiredPinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#a1a1aa" stroke="#52525b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
const searchPinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#3b82f6" stroke="#1e40af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;

const createIcon = (html: string) => L.divIcon({
  html,
  className: "bg-transparent border-none",
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  popupAnchor: [0, -32],
});

// ─────────────────────────────────────────────
// Image compression: resize to max 800×600, then
// iteratively reduce JPEG quality until under 1 MB.
// ─────────────────────────────────────────────
async function processImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX_W = 800;
        const MAX_H = 600;
        let { width, height } = img;
        const ratio = Math.min(MAX_W / width, MAX_H / height, 1);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas not supported"));
        ctx.drawImage(img, 0, 0, width, height);

        // Start at quality 0.82 and reduce until dataUrl fits inside 1 MB
        const TARGET_BYTES = 1024 * 1024;
        let quality = 0.82;
        let dataUrl = canvas.toDataURL("image/jpeg", quality);
        while (dataUrl.length * 0.75 > TARGET_BYTES && quality > 0.3) {
          quality -= 0.08;
          dataUrl = canvas.toDataURL("image/jpeg", quality);
        }
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error("Invalid image"));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ─────────────────────────────────────────────
// Clipboard helper with textarea fallback
// ─────────────────────────────────────────────
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// Timer helpers
// ─────────────────────────────────────────────

/** Format remaining ms as mm:ss (used for treasure code expiry timer). */
function formatCodeTimer(ms: number): string {
  if (ms <= 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/** Format remaining ms as HH:mm:ss (used for the image visibility countdown). */
function formatRemaining(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// ─────────────────────────────────────────────
// Guest Leaflet popup HTML (rebuilt each second)
// ─────────────────────────────────────────────
function buildGuestPopupHtml(g: GuestData, nowMs: number): string {
  const imgExpiresMs = new Date(g.imageExpiresAt).getTime();
  const imgRemaining = imgExpiresMs - nowMs;
  const imageExpired = g.imageExpired || imgRemaining <= 0;

  const imageBlock = imageExpired
    ? `<div style="width:100%;height:96px;margin-bottom:8px;display:flex;align-items:center;justify-content:center;background:#f3f4f6;color:#9ca3af;font-size:12px;font-style:italic;border:1px dashed #d1d5db;border-radius:4px">Zdjęcie wygasło</div>`
    : g.imageUrl
      ? `<img src="${g.imageUrl}" style="width:100%;height:96px;object-fit:cover;border-radius:4px;margin-bottom:8px"/>`
      : "";

  const imageTimerBlock = imageExpired
    ? `<div style="font-size:11px;color:#dc2626;font-weight:600;margin-top:4px">⏱️ Zdjęcie wygasło</div>`
    : `<div style="font-size:11px;color:#6b7280;margin-top:4px">⏱️ Zdjęcie dostępne do: <span style="font-family:monospace;font-weight:700;color:#b45309">${formatRemaining(imgRemaining)}</span></div>`;

  return `
    <div style="padding:8px;min-width:230px">
      ${imageBlock}
      <h3 style="font-weight:700;font-size:15px;color:#d97706">${g.markerTitle}</h3>
      <p style="font-size:12px;color:#374151;margin-top:4px;font-style:italic">💡 ${g.markerDescription}</p>
      <span style="display:inline-block;margin-top:8px;padding:2px 8px;background:#fef3c7;color:#92400e;border-radius:9999px;font-size:11px;font-weight:700;text-transform:uppercase">Moneta znaleziona!</span>
      ${imageTimerBlock}
      <button onclick="window.__thNavigate(${g.lat}, ${g.lng})"
        style="margin-top:10px;width:100%;background:#2563eb;color:#fff;font-size:13px;font-weight:600;padding:7px 10px;border:none;border-radius:6px;cursor:pointer">
        🧭 Nawiguj
      </button>
    </div>
  `;
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
type AppScreenProps = {
  user: { id: number; name: string; role: string } | null;
  guestData: GuestData | null;
  onLogout: () => void;
};

type MarkerItem = {
  id: number;
  title: string;
  description: string;
  code: string;
  lat: number;
  lng: number;
  expiresAt: string;
  redemptionCount: number;
  imageUrl?: string | null;
};

// ─────────────────────────────────────────────
// MarkerRow: individual admin list item with
// live mm:ss expiry countdown, copy button, and
// image preview trigger.
// ─────────────────────────────────────────────
function MarkerRow({
  m,
  onFly,
  onDelete,
  onCopy,
  onPreview,
}: {
  m: MarkerItem;
  onFly: (lat: number, lng: number, id: number) => void;
  onDelete: (id: number) => void;
  onCopy: (code: string) => void;
  onPreview: (m: MarkerItem) => void;
}) {
  // Each row manages its own 1-second tick so we don't re-render the whole list
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const expiresMs = new Date(m.expiresAt).getTime();
  const remaining = expiresMs - now;
  const isExpired = remaining <= 0;

  return (
    <div
      className={`p-3 rounded-md border text-sm transition-colors cursor-pointer ${
        isExpired
          ? "bg-gray-50 border-gray-100 opacity-60"
          : "bg-white hover:border-green-300 hover:shadow-sm"
      }`}
      onClick={() => onFly(m.lat, m.lng, m.id)}
    >
      {/* Title row */}
      <div className="flex justify-between items-start mb-1 gap-1">
        <span className={`font-semibold flex-1 min-w-0 truncate ${isExpired ? "text-gray-500" : "text-green-900"}`}>
          {m.title}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          {/* Image preview button (only if has image) */}
          {m.imageUrl && (
            <Button
              variant="ghost"
              size="icon"
              className="w-6 h-6 text-blue-400 hover:text-blue-700 hover:bg-blue-50"
              title="Podgląd zdjęcia"
              onClick={(e) => { e.stopPropagation(); onPreview(m); }}
            >
              <Eye className="w-3 h-3" />
            </Button>
          )}
          {/* Delete button */}
          <Button
            variant="ghost"
            size="icon"
            className="w-6 h-6 text-red-400 hover:text-red-700 hover:bg-red-50"
            title="Usuń skarb"
            onClick={(e) => { e.stopPropagation(); onDelete(m.id); }}
          >
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </div>

      {/* Code + copy + expiry timer */}
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <code
          className={`px-2 py-0.5 rounded text-xs font-mono font-bold tracking-widest ${
            isExpired ? "bg-gray-200 text-gray-400 line-through" : "bg-amber-100 text-amber-800"
          }`}
        >
          {m.code}
        </code>

        {/* Copy code button */}
        <Button
          variant="ghost"
          size="icon"
          className="w-5 h-5 text-gray-400 hover:text-green-700 hover:bg-green-50"
          title="Kopiuj kod"
          onClick={(e) => { e.stopPropagation(); onCopy(m.code); }}
        >
          <Copy className="w-3 h-3" />
        </Button>

        {/* Real-time mm:ss expiry countdown (red while counting, gray when expired) */}
        <span className={`flex items-center gap-0.5 text-xs font-mono font-semibold ml-auto ${isExpired ? "text-gray-400" : "text-red-500"}`}>
          <Clock className="w-3 h-3" />
          {isExpired ? "Wygasły" : formatCodeTimer(remaining)}
        </span>
      </div>

      <div className="text-xs text-gray-400 mt-1">{m.redemptionCount} odkryć</div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Main AppScreen component
// ─────────────────────────────────────────────
export default function AppScreen({ user, guestData, onLogout }: AppScreenProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Record<number, L.Marker>>({});
  const searchMarkerRef = useRef<L.Marker | null>(null);

  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [clickPos, setClickPos] = useState<{ lat: number; lng: number } | null>(null);
  const [saved, setSaved] = useState(false);

  // Form state
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newImg, setNewImg] = useState<string | null>(null);
  const [imgProcessing, setImgProcessing] = useState(false);

  // Image preview modal state (admin: view uploaded image for any marker)
  const [previewMarker, setPreviewMarker] = useState<MarkerItem | null>(null);

  // Address search (admin only)
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);

  // Mobile toggles: the admin side panel can be collapsed on mobile via arrow button
  const isMobile = useIsMobile();
  const [showStats, setShowStats] = useState(true);
  const [showTreasureList, setShowTreasureList] = useState(true);
  // Sidebar collapsed state (mobile): hides the panel but keeps the toggle button visible
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isAdmin = user?.role === "admin";
  const { data: markers = [] } = useListMarkers({
    query: { queryKey: getListMarkersQueryKey(), enabled: isAdmin },
  });
  const { data: stats } = useGetStats({
    query: { queryKey: getGetStatsQueryKey(), enabled: isAdmin },
  });

  const createMarker = useCreateMarker();
  const deleteMarker = useDeleteMarker();

  const showSaved = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // Open Google Maps directions
  const openInGoogleMaps = (lat: number, lng: number) => {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, "_blank", "noopener");
  };

  // ── Copy code helper: shows toast on success ──
  const handleCopyCode = useCallback(async (code: string) => {
    const ok = await copyToClipboard(code);
    toast({
      title: ok ? "Kod skopiowany" : "Nie udało się skopiować",
      description: ok ? `${code} jest w schowku` : "Spróbuj skopiować ręcznie.",
      variant: ok ? "default" : "destructive",
    });
  }, [toast]);

  // ── Map init ──
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    mapRef.current = L.map(mapContainer.current).setView([53.4285, 14.5528], 14);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(mapRef.current);

    if (isAdmin) {
      mapRef.current.on("click", (e) => {
        setClickPos({ lat: e.latlng.lat, lng: e.latlng.lng });
        setIsSheetOpen(true);
      });
    }
    return () => { mapRef.current?.remove(); mapRef.current = null; };
  }, [isAdmin]);

  // ── Wire navigate helper used by Leaflet popup HTML ──
  useEffect(() => {
    (window as unknown as { __thNavigate?: (lat: number, lng: number) => void }).__thNavigate = openInGoogleMaps;
    return () => { delete (window as unknown as { __thNavigate?: (lat: number, lng: number) => void }).__thNavigate; };
  }, []);

  // ── Guest popup: tick every second to update image countdown ──
  useEffect(() => {
    if (!guestData) return;
    const tick = () => {
      const marker = markersRef.current[guestData.markerId];
      if (marker) marker.setPopupContent(buildGuestPopupHtml(guestData, Date.now()));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [guestData]);

  // ── Place markers on map whenever data changes ──
  useEffect(() => {
    if (!mapRef.current) return;
    Object.values(markersRef.current).forEach((m) => m.remove());
    markersRef.current = {};

    if (guestData) {
      const marker = L.marker([guestData.lat, guestData.lng], { icon: createIcon(goldCoinHtml) })
        .addTo(mapRef.current)
        .bindPopup(buildGuestPopupHtml(guestData, Date.now()));
      markersRef.current[guestData.markerId] = marker;
      mapRef.current.flyTo([guestData.lat, guestData.lng], 16);
      marker.openPopup();
    } else if (isAdmin) {
      markers.forEach((m) => {
        const isExpired = new Date(m.expiresAt) < new Date();
        // Include thumbnail in admin popup when image exists
        const imgHtml = m.imageUrl
          ? `<img src="${m.imageUrl}" style="width:100%;height:80px;object-fit:cover;border-radius:4px;margin-bottom:6px"/>`
          : `<div style="width:100%;height:40px;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:11px;font-style:italic;margin-bottom:6px">Brak zdjęcia</div>`;
        const marker = L.marker([m.lat, m.lng], {
          icon: createIcon(isExpired ? expiredPinHtml : adminPinHtml),
          opacity: isExpired ? 0.55 : 1,
        })
          .addTo(mapRef.current!)
          .bindPopup(`
            <div style="padding:8px;min-width:200px">
              ${imgHtml}
              <h3 style="font-weight:700;font-size:14px;${isExpired ? "color:#9ca3af" : ""}">${m.title}${isExpired ? " (Wygasły)" : ""}</h3>
              <p style="font-size:12px;color:#6b7280;margin-top:4px">${m.description}</p>
              <div style="margin-top:8px;background:#f3f4f6;padding:6px;border-radius:4px;text-align:center">
                <code style="font-family:monospace;font-weight:700;letter-spacing:0.1em;${isExpired ? "color:#9ca3af;text-decoration:line-through" : "color:#15803d"}">${m.code}</code>
              </div>
              <div style="margin-top:6px;font-size:11px;color:#6b7280">Odkrycia: ${m.redemptionCount}</div>
            </div>
          `);
        markersRef.current[m.id] = marker;
      });
    }
  }, [guestData, isAdmin, markers]);

  const handleCreateMarker = (e: React.FormEvent) => {
    e.preventDefault();
    if (!clickPos || !newTitle || !newDesc) return;
    createMarker.mutate(
      { data: { title: newTitle, description: newDesc, lat: clickPos.lat, lng: clickPos.lng, imageUrl: newImg } },
      {
        onSuccess: async (created) => {
          queryClient.invalidateQueries({ queryKey: getListMarkersQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
          showSaved();
          const ok = await copyToClipboard(created.code);
          toast({
            title: "Skarb dodany!",
            description: ok ? `Kod ${created.code} skopiowany do schowka` : `Kod: ${created.code}`,
          });
          setIsSheetOpen(false);
          setNewTitle("");
          setNewDesc("");
          setNewImg(null);
        },
      }
    );
  };

  const handleDeleteMarker = (id: number) => {
    deleteMarker.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMarkersQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
          toast({ title: "Skarb usunięty" });
          showSaved();
        },
      }
    );
  };

  // Image upload: compress, preview. Hidden file input is re-triggered by buttons.
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImgProcessing(true);
    try {
      const dataUrl = await processImageFile(file);
      setNewImg(dataUrl);
    } catch {
      toast({ variant: "destructive", title: "Błąd zdjęcia", description: "Nie można przetworzyć obrazu." });
    } finally {
      setImgProcessing(false);
      e.target.value = "";
    }
  };

  const flyToMarker = (lat: number, lng: number, id: number) => {
    mapRef.current?.flyTo([lat, lng], 18);
    setTimeout(() => { markersRef.current[id]?.openPopup(); }, 500);
  };

  const handleAddressSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || !mapRef.current) return;
    setSearching(true);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=pl&q=${encodeURIComponent(searchQuery + ", Szczecin")}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const data = await res.json();
      if (!Array.isArray(data) || !data.length) {
        toast({ variant: "destructive", title: "Nie znaleziono", description: "Brak wyników dla tej ulicy." });
        return;
      }
      const lat = parseFloat(data[0].lat);
      const lng = parseFloat(data[0].lon);
      mapRef.current.flyTo([lat, lng], 16);
      if (searchMarkerRef.current) searchMarkerRef.current.remove();
      searchMarkerRef.current = L.marker([lat, lng], { icon: createIcon(searchPinHtml) })
        .addTo(mapRef.current)
        .bindPopup(`<div style="padding:4px"><b>📍 ${data[0].display_name}</b></div>`)
        .openPopup();
    } catch {
      toast({ variant: "destructive", title: "Błąd", description: "Nie udało się wyszukać adresu." });
    } finally {
      setSearching(false);
    }
  };

  // ─────────────────────────────────────────────
  // Guest: code expiry timer in topbar info chip
  // ─────────────────────────────────────────────
  const [guestNow, setGuestNow] = useState(Date.now());
  useEffect(() => {
    if (!guestData) return;
    const id = window.setInterval(() => setGuestNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [guestData]);

  return (
    <div className="flex flex-col h-[100dvh] w-full relative">

      {/* ── Topbar ── */}
      <header className="h-16 flex items-center justify-between px-3 sm:px-4 bg-white border-b shadow-sm z-[1000] relative shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-2xl">🪙</span>
          <h1 className="font-bold text-lg hidden sm:block text-green-950">Treasure Hunt</h1>
          <Badge
            variant="outline"
            className={isAdmin ? "bg-amber-100 text-amber-800 border-amber-200" : "bg-blue-100 text-blue-800 border-blue-200"}
          >
            {isAdmin ? <Shield className="w-3 h-3 mr-1" /> : <User className="w-3 h-3 mr-1" />}
            {isAdmin ? "Admin" : "Odkrywca"}
          </Badge>
        </div>

        <div className="flex items-center gap-1 sm:gap-3">
          {/* Mobile-only admin panel toggles */}
          {isAdmin && isMobile && (
            <>
              <Button
                variant={showStats ? "default" : "outline"}
                size="icon"
                className="w-8 h-8"
                onClick={() => setShowStats((v) => !v)}
                title="Pokaż/ukryj statystyki"
              >
                <BarChart3 className="w-4 h-4" />
              </Button>
              <Button
                variant={showTreasureList ? "default" : "outline"}
                size="icon"
                className="w-8 h-8"
                onClick={() => setShowTreasureList((v) => !v)}
                title="Pokaż/ukryj listę skarbów"
              >
                <List className="w-4 h-4" />
              </Button>
            </>
          )}

          {/* Guest: show discovered treasure name */}
          {guestData && (
            <span className="text-sm font-medium text-gray-600 hidden md:block truncate max-w-[180px]">
              🪙 {guestData.markerTitle}
            </span>
          )}

          {/* Admin name */}
          {isAdmin && (
            <span className="text-sm font-medium text-gray-600 hidden md:block">{user?.name}</span>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={onLogout}
            className="text-red-600 hover:text-red-700 hover:bg-red-50"
          >
            <LogOut className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Wyloguj</span>
          </Button>
        </div>
      </header>

      {/* ── Map + overlays ── */}
      <div className="flex-1 relative bg-slate-100 z-0">
        <div id="map" ref={mapContainer} className="absolute inset-0 w-full h-full" />

        {/* Address search (admin) */}
        {isAdmin && (
          <form
            onSubmit={handleAddressSearch}
            className="absolute top-4 left-4 z-[1000] bg-white/95 backdrop-blur shadow-lg rounded-lg border border-green-100 p-2 flex items-center gap-2 w-[260px] sm:w-72"
          >
            <Input
              placeholder="Szukaj ulicy w Szczecinie..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 text-sm border-none focus-visible:ring-1 focus-visible:ring-green-500"
            />
            <Button type="submit" size="icon" className="w-8 h-8 bg-green-700 hover:bg-green-800" disabled={searching}>
              {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            </Button>
          </form>
        )}

        {/* ── Admin Side Panel ──
            Desktop: fixed width 72–80, full glass.
            Mobile: max 65vw, higher transparency (70%), glassmorphism,
                    with a collapse arrow button on the left edge.
        ── */}
        {isAdmin && (
          <div
            className={`
              absolute top-4 right-0 flex flex-col gap-4 z-[1000]
              transition-transform duration-300 ease-in-out
              ${isMobile
                ? `${sidebarCollapsed ? "translate-x-full" : "translate-x-0"}`
                : "translate-x-0"
              }
            `}
            style={{
              width: isMobile ? "min(65vw, 280px)" : "320px",
              maxHeight: "calc(100% - 2rem)",
              paddingRight: "12px",
              paddingLeft: isMobile ? "0" : "0",
            }}
          >
            {/* Collapse toggle (mobile only) — floats to the left of the panel */}
            {isMobile && (
              <button
                onClick={() => setSidebarCollapsed((v) => !v)}
                className="absolute -left-8 top-0 w-8 h-10 bg-white/80 backdrop-blur rounded-l-lg border border-r-0 border-white/40 flex items-center justify-center shadow-md z-10"
                aria-label={sidebarCollapsed ? "Rozwiń panel" : "Zwiń panel"}
              >
                {sidebarCollapsed ? <ChevronLeft className="w-4 h-4 text-green-800" /> : <ChevronRight className="w-4 h-4 text-green-800" />}
              </button>
            )}

            {/* Stats card */}
            {stats && showStats && (
              <div
                className="shadow-lg rounded-lg p-4 pointer-events-auto border"
                style={{
                  background: isMobile ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.97)",
                  backdropFilter: "blur(12px)",
                  WebkitBackdropFilter: "blur(12px)",
                  borderColor: isMobile ? "rgba(255,255,255,0.35)" : "#dcfce7",
                }}
              >
                <h3 className="font-bold text-sm text-green-900 mb-2 uppercase tracking-wider">Statystyki</h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="bg-green-50/80 p-2 rounded">
                    <div className="text-green-600/70 text-xs">Aktywne</div>
                    <div className="font-bold text-green-800">{stats.activeMarkers}</div>
                  </div>
                  <div className="bg-gray-50/80 p-2 rounded">
                    <div className="text-gray-500 text-xs">Wygasłe</div>
                    <div className="font-bold text-gray-700">{stats.expiredMarkers}</div>
                  </div>
                  <div className="bg-amber-50/80 p-2 rounded col-span-2">
                    <div className="text-amber-600/70 text-xs">Odkrycia (łącznie)</div>
                    <div className="font-bold text-amber-800">{stats.totalRedemptions}</div>
                  </div>
                </div>
              </div>
            )}

            {/* Treasure list card */}
            {showTreasureList && (
              <div
                className="shadow-lg rounded-lg flex flex-col pointer-events-auto border overflow-hidden"
                style={{
                  maxHeight: isMobile ? "calc(100dvh - 200px)" : "500px",
                  background: isMobile ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.97)",
                  backdropFilter: "blur(12px)",
                  WebkitBackdropFilter: "blur(12px)",
                  borderColor: isMobile ? "rgba(255,255,255,0.35)" : "#dcfce7",
                }}
              >
                <div className="p-3 border-b border-green-50/60 flex justify-between items-center bg-green-50/50">
                  <h3 className="font-bold text-sm text-green-900 uppercase tracking-wider">
                    Skarby ({markers.length})
                  </h3>
                  <div className="flex items-center gap-2">
                    {saved && (
                      <span className="text-xs font-bold text-green-600 animate-in fade-in duration-200">✓ Zapisano</span>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="w-6 h-6"
                      onClick={() => queryClient.invalidateQueries({ queryKey: getListMarkersQueryKey() })}
                    >
                      <RefreshCcw className="w-3 h-3 text-green-700" />
                    </Button>
                  </div>
                </div>
                <ScrollArea className="flex-1 p-2">
                  <div className="space-y-2">
                    {markers.map((m) => (
                      <MarkerRow
                        key={m.id}
                        m={m}
                        onFly={flyToMarker}
                        onDelete={handleDeleteMarker}
                        onCopy={handleCopyCode}
                        onPreview={setPreviewMarker}
                      />
                    ))}
                    {markers.length === 0 && (
                      <div className="text-center p-4 text-gray-500 text-sm">
                        Brak skarbów. Kliknij na mapę, aby dodać nowy.
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        )}

        {/* Guest: code expiry info chip (bottom-center, visible on map) */}
        {guestData && (() => {
          const codeExpiresMs = new Date(guestData.imageExpiresAt).getTime(); // reuse imageExpiresAt as proxy isn't right...
          // Show image expiry chip on the map for the guest
          const imgExpiresMs = new Date(guestData.imageExpiresAt).getTime();
          const imgRemaining = imgExpiresMs - guestNow;
          const imgExpired = guestData.imageExpired || imgRemaining <= 0;
          return (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[999] pointer-events-none">
              <div className={`px-3 py-1.5 rounded-full text-xs font-semibold shadow-lg flex items-center gap-1.5 ${imgExpired ? "bg-red-100 text-red-700 border border-red-200" : "bg-white/90 text-amber-700 border border-amber-200"}`}>
                <Clock className="w-3 h-3" />
                {imgExpired
                  ? "Zdjęcie wygasło"
                  : `Zdjęcie dostępne: ${formatRemaining(imgRemaining)}`}
              </div>
            </div>
          );
        })()}
      </div>

      {/* ── Admin Create Sheet ── */}
      <Sheet open={isSheetOpen} onOpenChange={setIsSheetOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto sm:max-w-md sm:mx-auto rounded-t-xl">
          <SheetHeader>
            <SheetTitle>Ukryj nowy skarb</SheetTitle>
            <SheetDescription>
              Wprowadź dane skarbu. Kod zostanie wygenerowany automatycznie i skopiowany do schowka.
            </SheetDescription>
          </SheetHeader>
          <form onSubmit={handleCreateMarker} className="mt-4 space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Nazwa</label>
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                required
                placeholder="np. Złoty Graal na Wałach"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Wskazówka (opis)</label>
              <Textarea
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                required
                placeholder="Idź wzdłuż rzeki aż zobaczysz..."
                className="resize-none"
              />
            </div>

            {/* ── Image upload section with preview + remove/replace ── */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Zdjęcie (opcjonalne)</label>

              {/* Hidden file input — triggered by both "Wybierz" and "Zmień" buttons */}
              <input
                id="img-upload"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleImageUpload}
              />

              {newImg ? (
                /* Preview + replace/remove controls */
                <div className="space-y-2">
                  <div className="rounded-md overflow-hidden h-32 relative border border-gray-200">
                    <img src={newImg} alt="Preview" className="object-cover w-full h-full" />
                    {imgProcessing && (
                      <div className="absolute inset-0 bg-white/70 flex items-center justify-center">
                        <Loader2 className="w-6 h-6 animate-spin text-green-600" />
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => document.getElementById("img-upload")?.click()}
                      disabled={imgProcessing}
                    >
                      <ImageIcon className="w-3 h-3 mr-1" />
                      Zmień zdjęcie
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1 text-red-600 hover:bg-red-50 hover:text-red-700 border-red-200"
                      onClick={() => setNewImg(null)}
                      disabled={imgProcessing}
                    >
                      <X className="w-3 h-3 mr-1" />
                      Usuń zdjęcie
                    </Button>
                  </div>
                </div>
              ) : (
                /* No image yet — show single upload button */
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => document.getElementById("img-upload")?.click()}
                  disabled={imgProcessing}
                >
                  {imgProcessing ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Kompresja…</>
                  ) : (
                    <><ImageIcon className="w-4 h-4 mr-2" /> Wybierz zdjęcie</>
                  )}
                </Button>
              )}
              <p className="text-xs text-gray-400">Zdjęcia są automatycznie kompresowane do max 1 MB.</p>
            </div>

            <Button
              type="submit"
              className="w-full bg-green-600 hover:bg-green-700"
              disabled={createMarker.isPending || !newTitle || !newDesc || imgProcessing}
            >
              {createMarker.isPending ? "Zapisywanie..." : "Ukryj skarb"}
            </Button>
          </form>
        </SheetContent>
      </Sheet>

      {/* ── Image Preview Modal (admin: view any marker's image) ── */}
      <Dialog open={!!previewMarker} onOpenChange={(open) => !open && setPreviewMarker(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-green-900">{previewMarker?.title}</DialogTitle>
          </DialogHeader>
          {previewMarker?.imageUrl ? (
            <div className="rounded-md overflow-hidden border">
              <img
                src={previewMarker.imageUrl}
                alt={previewMarker.title}
                className="w-full object-contain max-h-72"
              />
            </div>
          ) : (
            <div className="h-32 flex items-center justify-center bg-gray-50 text-gray-400 text-sm italic border rounded-md">
              No image available
            </div>
          )}
          <p className="text-xs text-gray-500 italic">{previewMarker?.description}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  useListMarkers,
  useGetStats,
  useCreateMarker,
  useDeleteMarker,
  useGetDiscoveries,
  useResetDiscoveries,
  getListMarkersQueryKey,
  getGetStatsQueryKey,
  getGetDiscoveriesQueryKey,
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
  Check, ChevronDown, RotateCcw, Menu, Compass, MapPin, Sun, Moon, ChevronUp,
} from "lucide-react";

// ─────────────────────────────────────────────
// Map icon SVGs
// ─────────────────────────────────────────────
const goldCoinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#f59e0b" stroke="#b45309" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><circle cx="12" cy="12" r="10"/><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
const adminPinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#22c55e" stroke="#166534" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
// Red pin used while a marker's code is actively counting down (admin view).
const redPinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ef4444" stroke="#7f1d1d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
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

/** Format an ISO timestamp as "hh:mm dd/mm/yy" for the admin "Activation date" field. */
function formatActivationDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)}`;
}

/** Format an ISO timestamp as "hh:mm:ss" — used in the discoveries log entries. */
function formatLogTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format an ISO timestamp as "dd/mm/yy" — used for the "Last reset" label. */
function formatShortDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)}`;
}

// ─────────────────────────────────────────────
// Guest Leaflet popup HTML (static — the single
// countdown lives in the bottom-center chip).
// ─────────────────────────────────────────────
function buildGuestPopupHtml(g: GuestData): string {
  const imageBlock = g.imageUrl
    ? `<img src="${g.imageUrl}" style="width:100%;height:96px;object-fit:cover;border-radius:4px;margin-bottom:8px"/>`
    : "";

  return `
    <div style="padding:8px;min-width:230px">
      ${imageBlock}
      <h3 style="font-weight:700;font-size:15px;color:#d97706">${g.markerTitle}</h3>
      <p style="font-size:12px;color:#374151;margin-top:4px;font-style:italic">💡 ${g.markerDescription}</p>
      <span style="display:inline-block;margin-top:8px;padding:2px 8px;background:#fef3c7;color:#92400e;border-radius:9999px;font-size:11px;font-weight:700;text-transform:uppercase">Moneta znaleziona!</span>
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
  theme: "light" | "dark";
  onToggleTheme: () => void;
  loginMsg: string | null;
  onLoginMsgDismiss: () => void;
};

type MarkerItem = {
  id: number;
  title: string;
  description: string;
  code: string;
  lat: number;
  lng: number;
  // Null = code timer not started yet (no guest has entered the code).
  expiresAt: string | null;
  // Null until the first guest activates the code; mirrors the moment expiresAt was set.
  activatedAt: string | null;
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
  isSelected,
}: {
  m: MarkerItem;
  onFly: (lat: number, lng: number, id: number) => void;
  onDelete: (id: number) => void;
  onCopy: (code: string) => void;
  onPreview: (m: MarkerItem) => void;
  isSelected: boolean;
}) {
  // Each row manages its own 1-second tick so we don't re-render the whole list
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // When this row is selected (via map-marker click), scroll it into view inside
  // the right-hand sidebar list so the admin instantly sees it.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [isSelected]);

  // Three states:
  //   * expiresAt === null → code is set but timer hasn't started (no guest activated it yet)
  //   * remaining > 0       → countdown active
  //   * remaining <= 0      → code expired (greyed out for admin, hidden from guests)
  const notStarted = m.expiresAt === null;
  const expiresMs = m.expiresAt ? new Date(m.expiresAt).getTime() : 0;
  const remaining = expiresMs - now;
  const isExpired = !notStarted && remaining <= 0;

  return (
    <div
      ref={rowRef}
      className={`p-3 rounded-md text-sm transition-all cursor-pointer ${
        isSelected
          ? "border-2 border-green-600 shadow-md bg-white"
          : isExpired
            ? "border bg-gray-50 border-gray-100 opacity-60"
            : "border bg-white hover:border-green-300 hover:shadow-sm"
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

      {/* Code + copy button row */}
      <div className="flex items-center gap-2 mt-2">
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
          className="w-6 h-6 text-gray-400 hover:text-green-700 hover:bg-green-50"
          title="Kopiuj kod"
          onClick={(e) => { e.stopPropagation(); onCopy(m.code); }}
        >
          <Copy className="w-3.5 h-3.5" />
        </Button>

        {/* Per spec: replace the legacy "X odkryć" with the same activation-date
            field shown below — same font, same data source. Shows "—" until activated. */}
        <span className="text-[11px] text-gray-400 ml-auto font-mono">
          {m.activatedAt ? formatActivationDate(m.activatedAt) : "—"}
        </span>
      </div>

      {/* Activation date field — explicit label per spec.
          "Aktywacja" is the moment the FIRST guest entered the code. */}
      <div className="text-[11px] text-gray-500 mt-1.5 font-mono">
        Aktywacja: {m.activatedAt ? formatActivationDate(m.activatedAt) : "—"}
      </div>

      {/* Real-time mm:ss expiry countdown — placed BELOW the copy button as per spec.
          When the timer has not been started yet (no guest has entered the code),
          we show "Nieaktywny (60:00)" in grey so the admin knows the code is set
          to 60min but hasn't begun counting down. */}
      <div className={`flex items-center gap-1 mt-1 text-xs font-mono font-semibold ${
        notStarted ? "text-gray-500" : isExpired ? "text-gray-400" : "text-red-500"
      }`}>
        <Clock className="w-3 h-3" />
        {notStarted
          ? "Nieaktywny (60:00)"
          : isExpired
            ? "Wygasły"
            : `Pozostało: ${formatCodeTimer(remaining)}`}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Main AppScreen component
// ─────────────────────────────────────────────
export default function AppScreen({ user, guestData, onLogout, theme, onToggleTheme, loginMsg, onLoginMsgDismiss }: AppScreenProps) {
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
  // Briefly flashes a green check next to the image upload button after success.
  const [imgUploadedFlash, setImgUploadedFlash] = useState(false);

  // Selected marker (set by clicking a map marker — drives the bold-border row in the list).
  const [selectedMarkerId, setSelectedMarkerId] = useState<number | null>(null);

  // Stats filter — toggled by clicking the green "Aktywne" or grey "Wygasłe" stat tiles.
  // 'all'  → no filter | 'active' → expiresAt is null OR > now | 'expired' → expiresAt <= now
  const [statsFilter, setStatsFilter] = useState<"all" | "active" | "expired">("all");


  // Image preview modal state (admin: view uploaded image for any marker)
  const [previewMarker, setPreviewMarker] = useState<MarkerItem | null>(null);

  // Address search (admin only)
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);

  // Stats & Discoveries section collapse (persisted to localStorage)
  const [statsOpen, setStatsOpen] = useState<boolean>(() => {
    return localStorage.getItem("th_stats_open") !== "false";
  });
  const toggleStats = () => {
    setStatsOpen((v) => {
      const next = !v;
      localStorage.setItem("th_stats_open", String(next));
      return next;
    });
  };

  // Reverse-geocode cache: code → street label
  const geocacheRef = useRef<Map<string, string>>(new Map());
  const [streetLabels, setStreetLabels] = useState<Record<string, string>>({});

  const isMobile = useIsMobile();
  // Sidebar open/closed for mobile. Default closed; synced to breakpoint.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    setSidebarCollapsed(isMobile);
  }, [isMobile]);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isAdmin = user?.role === "admin";
  const { data: markers = [] } = useListMarkers({
    query: { queryKey: getListMarkersQueryKey(), enabled: isAdmin },
  });
  const { data: stats } = useGetStats({
    query: { queryKey: getGetStatsQueryKey(), enabled: isAdmin },
  });
  const { data: discoveries } = useGetDiscoveries({
    // Auto-refresh so the counter and recent log stay live while the admin watches.
    query: { queryKey: getGetDiscoveriesQueryKey(), enabled: isAdmin, refetchInterval: 5000 },
  });

  const createMarker = useCreateMarker();
  const deleteMarker = useDeleteMarker();
  const resetDiscoveries = useResetDiscoveries();

  // Filtered marker list driven by the stats-tile toggle.
  // Source of truth for both the list rendering AND the map placement effect.
  const filteredMarkers = useMemo(() => {
    if (statsFilter === "all") return markers;
    const now = Date.now();
    return markers.filter((m) => {
      const expired = m.expiresAt !== null && new Date(m.expiresAt).getTime() <= now;
      return statsFilter === "active" ? !expired : expired;
    });
  }, [markers, statsFilter]);

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

  // ── Guest map placement (split out so it doesn't re-run on admin/marker
  //    changes, and CRITICALLY does not re-run on the per-second `guestNow`
  //    tick — that re-run was tearing down and rebuilding the marker every
  //    second and felt like the map was locked. We key purely on markerId
  //    so a new guest session re-fires, but a re-render does not). ──
  useEffect(() => {
    if (!mapRef.current || !guestData) return;
    // Snapshot identity values into local consts so the cleanup closure doesn't
    // depend on the guestData object identity.
    const { markerId, lat, lng } = guestData;
    const popupHtml = buildGuestPopupHtml(guestData);
    const marker = L.marker([lat, lng], { icon: createIcon(goldCoinHtml) })
      .addTo(mapRef.current)
      .bindPopup(popupHtml);
    markersRef.current[markerId] = marker;
    mapRef.current.flyTo([lat, lng], 16);
    marker.openPopup();
    return () => {
      marker.remove();
      delete markersRef.current[markerId];
    };
    // Intentionally only depend on the marker identity. Re-renders from the
    // 1-second countdown tick must NOT re-trigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guestData?.markerId]);

  // ── Admin map placement (only fires for admin and when the filtered list
  //    actually changes). ──
  useEffect(() => {
    if (!mapRef.current || !isAdmin) return;
    // Tear down any previous admin pins before re-rendering.
    Object.values(markersRef.current).forEach((m) => m.remove());
    markersRef.current = {};
    filteredMarkers.forEach((m) => {
      // Three pin colours:
      //   - grey   → expired (timer started AND past)
      //   - red    → counting down (timer started, still in the future)
      //   - green  → not yet activated by any guest (expiresAt is null)
      const expired = m.expiresAt !== null && new Date(m.expiresAt) < new Date();
      const counting = m.expiresAt !== null && !expired;
      const pinHtml = expired ? expiredPinHtml : counting ? redPinHtml : adminPinHtml;
      const imgHtml = m.imageUrl
        ? `<img src="${m.imageUrl}" style="width:100%;height:80px;object-fit:cover;border-radius:4px;margin-bottom:6px"/>`
        : `<div style="width:100%;height:40px;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:11px;font-style:italic;margin-bottom:6px">Brak zdjęcia</div>`;
      const marker = L.marker([m.lat, m.lng], {
        icon: createIcon(pinHtml),
        opacity: expired ? 0.55 : 1,
      })
        .addTo(mapRef.current!)
        .bindPopup(`
          <div style="padding:8px;min-width:200px">
            ${imgHtml}
            <h3 style="font-weight:700;font-size:14px;${expired ? "color:#9ca3af" : ""}">${m.title}${expired ? " (Wygasły)" : ""}</h3>
            <p style="font-size:12px;color:#6b7280;margin-top:4px">${m.description}</p>
            <div style="margin-top:8px;background:#f3f4f6;padding:6px;border-radius:4px;text-align:center">
              <code style="font-family:monospace;font-weight:700;letter-spacing:0.1em;${expired ? "color:#9ca3af;text-decoration:line-through" : "color:#15803d"}">${m.code}</code>
            </div>
          </div>
        `);
      // Click → highlight the corresponding row in the right-hand list.
      marker.on("click", () => setSelectedMarkerId(m.id));
      markersRef.current[m.id] = marker;
    });
  }, [isAdmin, filteredMarkers]);

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
      // Flash a green checkmark for ~2s to confirm the upload succeeded.
      setImgUploadedFlash(true);
      window.setTimeout(() => setImgUploadedFlash(false), 2000);
    } catch {
      toast({ variant: "destructive", title: "Błąd zdjęcia", description: "Nie można przetworzyć obrazu." });
    } finally {
      setImgProcessing(false);
      e.target.value = "";
    }
  };

  const flyToMarker = (lat: number, lng: number, id: number) => {
    setSelectedMarkerId(id);
    mapRef.current?.flyTo([lat, lng], 18);
    setTimeout(() => { markersRef.current[id]?.openPopup(); }, 500);
  };

  const handleResetDiscoveries = () => {
    resetDiscoveries.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDiscoveriesQueryKey() });
        toast({ title: "Licznik odkryć zresetowany" });
      },
    });
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
  // Login notification: auto-dismiss after 3 s
  // ─────────────────────────────────────────────
  useEffect(() => {
    if (!loginMsg) return;
    const id = window.setTimeout(() => onLoginMsgDismiss(), 3000);
    return () => window.clearTimeout(id);
  }, [loginMsg, onLoginMsgDismiss]);

  // ─────────────────────────────────────────────
  // Reverse-geocode recent activations (Nominatim)
  // ─────────────────────────────────────────────
  useEffect(() => {
    if (!discoveries?.recent?.length || !markers.length) return;
    for (const r of discoveries.recent) {
      if (geocacheRef.current.has(r.code)) continue;
      const marker = markers.find((m) => m.code === r.code);
      if (!marker) {
        geocacheRef.current.set(r.code, "Nieznana lokalizacja");
        setStreetLabels((p) => ({ ...p, [r.code]: "Nieznana lokalizacja" }));
        continue;
      }
      (async () => {
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${marker.lat}&lon=${marker.lng}`,
            { headers: { Accept: "application/json" } }
          );
          const data = await res.json() as { address?: Record<string, string>; display_name?: string };
          const street =
            data.address?.road ??
            data.address?.pedestrian ??
            data.address?.path ??
            data.display_name?.split(",")[0] ??
            "Nieznana lokalizacja";
          geocacheRef.current.set(r.code, street);
          setStreetLabels((p) => ({ ...p, [r.code]: street }));
        } catch {
          geocacheRef.current.set(r.code, "Nieznana lokalizacja");
          setStreetLabels((p) => ({ ...p, [r.code]: "Nieznana lokalizacja" }));
        }
      })();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discoveries?.recent, markers]);

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
          <h1 className="font-bold text-lg hidden sm:block text-green-950 dark:text-green-100">Pysne.com.pl</h1>
          <Badge
            variant="outline"
            className={isAdmin ? "bg-amber-100 text-amber-800 border-amber-200" : "bg-blue-100 text-blue-800 border-blue-200"}
          >
            {isAdmin ? <Shield className="w-3 h-3 mr-1" /> : <User className="w-3 h-3 mr-1" />}
            {isAdmin ? "Admin" : "Odkrywca"}
          </Badge>
        </div>

        <div className="flex items-center gap-1 sm:gap-3">

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

          {/* Light / dark mode toggle */}
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleTheme}
            title={theme === "dark" ? "Tryb jasny" : "Tryb ciemny"}
            className="w-8 h-8 text-gray-500 hover:text-amber-600 hover:bg-amber-50"
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>

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

        {/* Address search (admin) — bottom-centered, responsive width */}
        {isAdmin && (
          <form
            onSubmit={handleAddressSearch}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[1000] bg-white/95 backdrop-blur shadow-lg rounded-lg border border-green-100 p-2 flex items-center gap-2 w-[min(92vw,360px)]"
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

        {/* ── Admin Side Panel (RIGHT) ──
            Desktop: fixed 320 px column on the right, always visible.
            Mobile: hidden by default; hamburger (top-right) slides it in from the right.
            No accordion — all sections are always expanded and readable at once.
        ── */}
        {isAdmin && (
          <>
            {/* Mobile hamburger — top-right corner of the map */}
            {isMobile && (
              <button
                type="button"
                onClick={() => setSidebarCollapsed((v) => !v)}
                aria-label={sidebarCollapsed ? "Otwórz panel" : "Zamknij panel"}
                className="absolute top-3 right-3 z-[1100] w-11 h-11 bg-white rounded-xl shadow-lg border border-gray-200 flex items-center justify-center active:scale-95 transition-transform"
              >
                {sidebarCollapsed ? (
                  <Menu className="w-5 h-5 text-green-800" />
                ) : (
                  <X className="w-5 h-5 text-green-800" />
                )}
              </button>
            )}

            {/* Mobile backdrop */}
            {isMobile && !sidebarCollapsed && (
              <button
                type="button"
                aria-label="Zamknij panel"
                onClick={() => setSidebarCollapsed(true)}
                className="absolute inset-0 bg-black/30 z-[1040] animate-in fade-in duration-200"
              />
            )}

            <aside
              className={`
                absolute right-0 top-0 bottom-0 z-[1050]
                flex flex-col bg-[#fafbfc] border-l border-gray-200 shadow-xl
                overflow-y-auto
                transition-transform duration-300 ease-in-out
                ${isMobile
                  ? (sidebarCollapsed ? "translate-x-full" : "translate-x-0")
                  : "translate-x-0"}
              `}
              style={{ width: isMobile ? "min(86vw, 340px)" : "320px" }}
            >
              {/* ── Header ── */}
              <div className="px-4 h-12 flex items-center justify-between border-b border-gray-200 bg-white shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Shield className="w-4 h-4 text-green-700 shrink-0" />
                  <span className="text-sm font-semibold text-gray-800 truncate">
                    {user?.name ?? "admin"}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onLogout}
                  className="h-8 px-2 text-red-600 hover:text-red-700 hover:bg-red-50 shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5 mr-1" />
                  <span className="text-xs">Wyloguj</span>
                </Button>
              </div>

              <div className="flex flex-col gap-4 p-3">

                {/* ── Combined: STATYSTYKI & ODKRYCIA (collapsible) ── */}
                <section className="bg-white border border-gray-200 rounded-xl shadow-sm">
                  {/* Section title — click anywhere on header to collapse */}
                  <button
                    type="button"
                    onClick={toggleStats}
                    className="w-full px-4 pt-3 pb-2 border-b border-gray-100 flex items-center justify-between gap-2 hover:bg-gray-50 rounded-t-xl transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <BarChart3 className="w-4 h-4 text-green-700" />
                      <span className="text-xs font-bold tracking-wider text-gray-800 uppercase">
                        Statystyki &amp; Odkrycia
                      </span>
                      {/* Compact summary visible when collapsed */}
                      {!statsOpen && stats && discoveries && (
                        <span className="text-[10px] text-gray-400 font-normal ml-1">
                          {stats.activeMarkers}A / {stats.expiredMarkers}W · {discoveries.count} odkryć
                        </span>
                      )}
                    </div>
                    {statsOpen
                      ? <ChevronUp className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                      : <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    }
                  </button>

                  {statsOpen && (
                    <div className="px-4 py-3 flex flex-col gap-3">
                      {/* Stat tiles */}
                      {stats && (
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setStatsFilter((f) => (f === "active" ? "all" : "active"))}
                            className={`bg-white border rounded-xl px-3 py-2.5 text-left transition-all flex flex-col gap-0.5 ${
                              statsFilter === "active"
                                ? "ring-2 ring-green-500 border-green-300"
                                : "border-gray-200 hover:border-green-300"
                            }`}
                          >
                            <span className="flex items-center gap-1.5 text-[11px] text-gray-500">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                              Aktywne
                            </span>
                            <span className="font-bold text-2xl text-gray-900 leading-tight">
                              {stats.activeMarkers}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setStatsFilter((f) => (f === "expired" ? "all" : "expired"))}
                            className={`bg-white border rounded-xl px-3 py-2.5 text-left transition-all flex flex-col gap-0.5 ${
                              statsFilter === "expired"
                                ? "ring-2 ring-red-400 border-red-200"
                                : "border-gray-200 hover:border-red-200"
                            }`}
                          >
                            <span className="flex items-center gap-1.5 text-[11px] text-gray-500">
                              <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                              Wygasłe
                            </span>
                            <span className="font-bold text-2xl text-gray-900 leading-tight">
                              {stats.expiredMarkers}
                            </span>
                          </button>
                        </div>
                      )}
                      {statsFilter !== "all" && (
                        <button
                          type="button"
                          onClick={() => setStatsFilter("all")}
                          className="text-[11px] text-green-700 hover:underline self-start -mt-1"
                        >
                          Wyczyść filtr
                        </button>
                      )}

                      {/* Divider */}
                      <div className="border-t border-gray-100" />

                      {/* Odkrycia data */}
                      {discoveries && (
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center gap-2">
                            <Compass className="w-3.5 h-3.5 text-green-700 shrink-0" />
                            <span className="text-xs font-bold tracking-wider text-gray-700 uppercase">Odkrycia</span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-[12px]">
                            <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                              <div className="text-gray-500 text-[10px] mb-0.5">Ostatni reset</div>
                              <div className="font-mono font-semibold text-gray-900">
                                {formatShortDate(discoveries.lastResetAt)}
                              </div>
                            </div>
                            <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                              <div className="text-gray-500 text-[10px] mb-0.5">Od resetu</div>
                              <div className="font-mono font-bold text-2xl text-gray-900 leading-tight">
                                {discoveries.count}
                              </div>
                            </div>
                          </div>

                          <Button
                            type="button"
                            size="sm"
                            onClick={handleResetDiscoveries}
                            disabled={resetDiscoveries.isPending}
                            className="h-8 w-full text-[12px] font-semibold bg-amber-400 hover:bg-amber-500 text-amber-950 border-0"
                          >
                            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                            Resetuj licznik odkryć
                          </Button>

                          {/* Recent activations log — code + time + street name */}
                          <div>
                            <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">
                              Ostatnie aktywacje ({discoveries.recent.length})
                            </div>
                            {discoveries.recent.length === 0 ? (
                              <div className="text-[11px] italic text-gray-400 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                                Brak aktywacji od ostatniego resetu.
                              </div>
                            ) : (
                              <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2 font-mono text-[10px] leading-relaxed space-y-0.5 text-yellow-900">
                                {discoveries.recent.map((r) => (
                                  <div key={`${r.code}-${r.activatedAt}`}>
                                    <span className="text-yellow-600">({formatLogTime(r.activatedAt)})</span>
                                    {" — "}{r.code}
                                    {" — "}
                                    <span className="text-yellow-700 italic">
                                      {streetLabels[r.code] ?? "…"}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>

                {/* ── SKARBY list ── */}
                <section className="bg-white border border-gray-200 rounded-xl shadow-sm">
                  <div className="px-4 pt-3 pb-2 border-b border-gray-100 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-green-700" />
                      <span className="text-xs font-bold tracking-wider text-gray-800 uppercase">
                        Skarby ({filteredMarkers.length}
                        {statsFilter !== "all" ? `/${markers.length}` : ""})
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {saved && (
                        <span className="text-[10px] font-bold text-green-600">✓ Zapisano</span>
                      )}
                      <button
                        type="button"
                        onClick={() => queryClient.invalidateQueries({ queryKey: getListMarkersQueryKey() })}
                        className="w-7 h-7 inline-flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors"
                        title="Odśwież"
                      >
                        <RefreshCcw className="w-3.5 h-3.5 text-gray-500" />
                      </button>
                    </div>
                  </div>

                  <div className="p-3 flex flex-col gap-2">
                    {filteredMarkers.map((m) => (
                      <MarkerRow
                        key={m.id}
                        m={m}
                        onFly={flyToMarker}
                        onDelete={handleDeleteMarker}
                        onCopy={handleCopyCode}
                        onPreview={setPreviewMarker}
                        isSelected={selectedMarkerId === m.id}
                      />
                    ))}
                    {filteredMarkers.length === 0 && (
                      <div className="text-center p-4 text-gray-500 text-sm">
                        {markers.length === 0
                          ? "Brak skarbów. Kliknij na mapę, aby dodać nowy."
                          : "Brak skarbów pasujących do filtra."}
                      </div>
                    )}
                  </div>
                </section>

              </div>
            </aside>
          </>
        )}

        {/* ── Admin login welcome notification (bottom-center, 3 s auto-dismiss) ── */}
        {loginMsg && (
          <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-[2000] pointer-events-none animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="px-5 py-2.5 rounded-2xl bg-white/90 backdrop-blur shadow-lg border border-green-100 text-[13px] font-medium text-green-900 whitespace-nowrap">
              {loginMsg}
            </div>
          </div>
        )}

        {/* Guest: code expiry mm:ss countdown (bottom-center, visible on map).
            Per spec, the same red mm:ss timer that admins see for the code must
            also be visible to the user/guest. */}
        {guestData && (() => {
          const codeExpiresMs = new Date(guestData.markerExpiresAt).getTime();
          const codeRemaining = codeExpiresMs - guestNow;
          const codeExpired = codeRemaining <= 0;
          return (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[999] pointer-events-none">
              {/* Minimalist guest timer: just a clock icon + mm:ss. No "Pozostało:" label. */}
              <div className={`px-4 py-2 rounded-full text-sm font-mono font-bold shadow-lg flex items-center gap-2 border ${
                codeExpired
                  ? "bg-gray-100 text-gray-500 border-gray-200"
                  : "bg-white/90 text-red-600 border-red-200"
              }`}>
                <Clock className="w-4 h-4" />
                {codeExpired ? "00:00" : formatCodeTimer(codeRemaining)}
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
                    {/* Brief green-check confirmation after a successful upload. */}
                    {imgUploadedFlash && !imgProcessing && (
                      <div className="absolute top-1 right-1 bg-green-600 text-white rounded-full p-1 shadow animate-in fade-in zoom-in duration-200">
                        <Check className="w-4 h-4" />
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
                  ) : imgUploadedFlash ? (
                    <><Check className="w-4 h-4 mr-2 text-green-600" /> Wgrane</>
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

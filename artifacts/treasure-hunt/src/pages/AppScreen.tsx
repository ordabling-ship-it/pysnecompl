import { useEffect, useRef, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  LogOut, Search, Shield, User, Image as ImageIcon, Trash2, RefreshCcw,
  BarChart3, List, Loader2,
} from "lucide-react";

// Icon SVGs
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

// Resize+compress an image File to fit inside 640x480 (preserving aspect ratio),
// returning a JPEG dataURL. Significantly reduces storage size.
async function processImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX_W = 640;
        const MAX_H = 480;
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
        // JPEG with 0.7 quality keeps file size tiny while looking acceptable
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      };
      img.onerror = () => reject(new Error("Invalid image"));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Copy any string to clipboard with a fallback for older/insecure browsers
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    // Fallback: temporary textarea + execCommand
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

type AppScreenProps = {
  user: { id: number; name: string; role: string } | null;
  guestData: GuestData | null;
  onLogout: () => void;
};

// Format milliseconds as HH:MM:SS for the image-visibility countdown
function formatRemaining(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// Build the inner HTML of the guest treasure popup. Re-rendered every second
// so the countdown updates and the image swaps to "Zdjęcie wygasło" on time.
function buildGuestPopupHtml(g: GuestData, nowMs: number): string {
  const expiresMs = new Date(g.imageExpiresAt).getTime();
  const remaining = expiresMs - nowMs;
  const expired = g.imageExpired || remaining <= 0;

  const imageBlock = expired
    ? `<div class="w-full h-24 mb-2 flex items-center justify-center bg-gray-100 text-gray-500 text-sm italic rounded border border-dashed border-gray-300">Zdjęcie wygasło</div>`
    : g.imageUrl
      ? `<img src="${g.imageUrl}" class="w-full h-24 object-cover rounded mb-2"/>`
      : "";

  const timerBlock = expired
    ? `<div class="text-xs text-red-600 font-semibold mt-1">⏱️ Zdjęcie wygasło</div>`
    : `<div class="text-xs text-gray-500 mt-1">⏱️ Zdjęcie dostępne do: <span class="font-mono font-semibold text-amber-700">${formatRemaining(remaining)}</span></div>`;

  return `
    <div class="p-2 min-w-[230px]">
      ${imageBlock}
      <h3 class="font-bold text-base text-amber-600">${g.markerTitle}</h3>
      <p class="text-sm text-gray-700 mt-1 italic">💡 ${g.markerDescription}</p>
      <span class="inline-block mt-2 px-2 py-1 bg-amber-100 text-amber-800 rounded-full text-xs font-bold uppercase">Moneta znaleziona!</span>
      ${timerBlock}
      <button onclick="window.__thNavigate(${g.lat}, ${g.lng})"
        class="mt-3 w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2 px-3 rounded flex items-center justify-center gap-1">
        🧭 Nawiguj
      </button>
    </div>
  `;
}

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

  // Address search (admin only)
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);

  // Mobile UI toggles (admin only): control visibility of Stats and Treasures panels on mobile
  const isMobile = useIsMobile();
  const [showStats, setShowStats] = useState(true);
  const [showTreasureList, setShowTreasureList] = useState(true);

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

  // Open Google Maps directions to a coordinate (works for foot or car — user picks)
  const openInGoogleMaps = (lat: number, lng: number) => {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    window.open(url, "_blank", "noopener");
  };

  useEffect(() => {
    if (!mapContainer.current) return;
    if (mapRef.current) return;

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

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [isAdmin]);

  // Wire up the global navigate function used by Leaflet popup HTML buttons
  useEffect(() => {
    (window as unknown as { __thNavigate?: (lat: number, lng: number) => void }).__thNavigate = openInGoogleMaps;
    return () => {
      delete (window as unknown as { __thNavigate?: (lat: number, lng: number) => void }).__thNavigate;
    };
  }, []);

  // Tick the guest popup once per second so the "Zdjęcie dostępne do: HH:MM:SS"
  // countdown stays live and the image swaps to "Zdjęcie wygasło" on expiry.
  // setPopupContent() updates the popup in place without closing it.
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

  useEffect(() => {
    if (!mapRef.current) return;

    Object.values(markersRef.current).forEach((m) => m.remove());
    markersRef.current = {};

    if (guestData) {
      // Guest popup: image + countdown + title + hint + Navigate button.
      // Initial render uses Date.now(); a separate effect ticks every second.
      const marker = L.marker([guestData.lat, guestData.lng], { icon: createIcon(goldCoinHtml) })
        .addTo(mapRef.current)
        .bindPopup(buildGuestPopupHtml(guestData, Date.now()));
      markersRef.current[guestData.markerId] = marker;
      mapRef.current.flyTo([guestData.lat, guestData.lng], 16);
      marker.openPopup();
    } else if (isAdmin) {
      // Admin: show all markers, expired ones greyed out, never hidden
      markers.forEach((m) => {
        const isExpired = new Date(m.expiresAt) < new Date();
        const marker = L.marker([m.lat, m.lng], {
          icon: createIcon(isExpired ? expiredPinHtml : adminPinHtml),
          opacity: isExpired ? 0.55 : 1,
        })
          .addTo(mapRef.current!)
          .bindPopup(`
            <div class="p-2 min-w-[200px]">
              <h3 class="font-bold text-lg ${isExpired ? "text-gray-400" : ""}">${m.title}${isExpired ? " (Wygasły)" : ""}</h3>
              <p class="text-sm text-gray-600 mt-1">${m.description}</p>
              <div class="mt-2 bg-gray-100 p-2 rounded text-center">
                <code class="font-mono font-bold tracking-widest ${isExpired ? "text-gray-400 line-through" : "text-green-700"}">${m.code}</code>
              </div>
              <div class="mt-2 text-xs text-gray-500">Odkrycia: ${m.redemptionCount}</div>
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
      {
        data: {
          title: newTitle,
          description: newDesc,
          lat: clickPos.lat,
          lng: clickPos.lng,
          imageUrl: newImg,
        },
      },
      {
        onSuccess: async (created) => {
          queryClient.invalidateQueries({ queryKey: getListMarkersQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
          showSaved();
          // Auto-copy generated code to clipboard
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

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImgProcessing(true);
    try {
      const dataUrl = await processImageFile(file);
      setNewImg(dataUrl);
    } catch (err) {
      toast({ variant: "destructive", title: "Błąd zdjęcia", description: "Nie można przetworzyć obrazu." });
    } finally {
      setImgProcessing(false);
      // reset so the same file can be picked again
      e.target.value = "";
    }
  };

  const flyToMarker = (lat: number, lng: number, id: number) => {
    mapRef.current?.flyTo([lat, lng], 18);
    setTimeout(() => {
      markersRef.current[id]?.openPopup();
    }, 500);
  };

  // Geocode an address via OpenStreetMap Nominatim — free, no API key
  const handleAddressSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || !mapRef.current) return;
    setSearching(true);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=pl&q=${encodeURIComponent(
        searchQuery + ", Szczecin"
      )}`;
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
        .bindPopup(`<div class="p-1"><b>📍 ${data[0].display_name}</b></div>`)
        .openPopup();
    } catch {
      toast({ variant: "destructive", title: "Błąd", description: "Nie udało się wyszukać adresu." });
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="flex flex-col h-[100dvh] w-full relative">
      {/* Topbar */}
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
          {/* Mobile-only admin toggles for Stats / Treasures panels */}
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
          <span className="text-sm font-medium text-gray-600 hidden md:block">
            {isAdmin ? user?.name : guestData?.markerTitle}
          </span>
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

      {/* Map Container */}
      <div className="flex-1 relative bg-slate-100 z-0">
        <div id="map" ref={mapContainer} className="absolute inset-0 w-full h-full" />

        {/* Admin address search bar — top-left, admin only */}
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

        {/* Admin Side Panel */}
        {isAdmin && (
          <div className="absolute top-4 right-4 w-72 sm:w-80 max-h-[calc(100%-2rem)] flex flex-col gap-4 z-[1000] pointer-events-none">
            {stats && showStats && (
              <div className="bg-white/95 backdrop-blur shadow-lg rounded-lg p-4 pointer-events-auto border border-green-100">
                <h3 className="font-bold text-sm text-green-900 mb-2 uppercase tracking-wider">Statystyki</h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="bg-green-50 p-2 rounded">
                    <div className="text-green-600/70 text-xs">Aktywne</div>
                    <div className="font-bold text-green-800">{stats.activeMarkers}</div>
                  </div>
                  <div className="bg-gray-50 p-2 rounded">
                    <div className="text-gray-500 text-xs">Wygasłe</div>
                    <div className="font-bold text-gray-700">{stats.expiredMarkers}</div>
                  </div>
                  <div className="bg-amber-50 p-2 rounded col-span-2">
                    <div className="text-amber-600/70 text-xs">Odkrycia (łącznie)</div>
                    <div className="font-bold text-amber-800">{stats.totalRedemptions}</div>
                  </div>
                </div>
              </div>
            )}

            {showTreasureList && (
              <div className="bg-white/95 backdrop-blur shadow-lg rounded-lg flex flex-col pointer-events-auto border border-green-100 max-h-[500px] overflow-hidden">
                <div className="p-3 border-b flex justify-between items-center bg-green-50/50">
                  <h3 className="font-bold text-sm text-green-900 uppercase tracking-wider">
                    Skarby ({markers.length})
                  </h3>
                  <div className="flex items-center gap-2">
                    {saved && (
                      <span className="text-xs font-bold text-green-600 animate-in fade-in duration-200">
                        ✓ Zapisano
                      </span>
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
                    {markers.map((m) => {
                      const isExpired = new Date(m.expiresAt) < new Date();
                      return (
                        <div
                          key={m.id}
                          className={`p-3 rounded-md border text-sm transition-colors cursor-pointer ${
                            isExpired
                              ? "bg-gray-50 border-gray-100 opacity-60"
                              : "bg-white hover:border-green-300 hover:shadow-sm"
                          }`}
                          onClick={() => flyToMarker(m.lat, m.lng, m.id)}
                        >
                          <div className="flex justify-between items-start mb-1">
                            <span className={`font-semibold ${isExpired ? "text-gray-500" : "text-green-900"}`}>
                              {m.title} {isExpired && "(Wygasły)"}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="w-6 h-6 text-red-400 hover:text-red-700 hover:bg-red-50"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteMarker(m.id);
                              }}
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                          <div className="flex items-center gap-2 mt-2">
                            <code
                              className={`px-2 py-0.5 rounded text-xs font-mono font-bold tracking-widest ${
                                isExpired
                                  ? "bg-gray-200 text-gray-400 line-through"
                                  : "bg-amber-100 text-amber-800"
                              }`}
                            >
                              {m.code}
                            </code>
                            <span className="text-xs text-gray-500 ml-auto">{m.redemptionCount} odkryć</span>
                          </div>
                        </div>
                      );
                    })}
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
      </div>

      {/* Admin Create Sheet */}
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
            <div className="space-y-2">
              <label className="text-sm font-medium">Zdjęcie (opcjonalne, auto-zmniejszone do 640×480)</label>
              <div className="flex items-center gap-4">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => document.getElementById("img-upload")?.click()}
                  disabled={imgProcessing}
                >
                  {imgProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Przetwarzanie...
                    </>
                  ) : (
                    <>
                      <ImageIcon className="w-4 h-4 mr-2" /> Wybierz zdjęcie
                    </>
                  )}
                </Button>
                <input
                  id="img-upload"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleImageUpload}
                />
              </div>
              {newImg && (
                <div className="mt-2 rounded-md overflow-hidden h-32 relative border">
                  <img src={newImg} alt="Preview" className="object-cover w-full h-full" />
                </div>
              )}
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
    </div>
  );
}

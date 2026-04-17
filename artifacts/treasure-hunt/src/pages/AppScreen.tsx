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
  Marker
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { LogOut, MapPin, Search, Shield, User, Image as ImageIcon, Map as MapIcon, Plus, Trash2, RefreshCcw } from "lucide-react";

// Icons setup
const goldCoinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#f59e0b" stroke="#b45309" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><circle cx="12" cy="12" r="10"/><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
const grayCoinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#d4d4d8" stroke="#71717a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
const adminPinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#22c55e" stroke="#166534" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
const expiredPinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#a1a1aa" stroke="#52525b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;

const createIcon = (html: string) => L.divIcon({
  html,
  className: "bg-transparent border-none",
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  popupAnchor: [0, -32],
});

type AppScreenProps = {
  user: { id: number; name: string; role: string } | null;
  guestData: { markerId: number; code: string; markerTitle: string; lat: number; lng: number } | null;
  onLogout: () => void;
};

export default function AppScreen({ user, guestData, onLogout }: AppScreenProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Record<number, L.Marker>>({});
  
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [clickPos, setClickPos] = useState<{lat: number, lng: number} | null>(null);
  const [saved, setSaved] = useState(false);
  
  // New marker form
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newImg, setNewImg] = useState<string | null>(null);

  const showSaved = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isAdmin = user?.role === "admin";
  const { data: markers = [] } = useListMarkers({ query: { enabled: isAdmin } });
  const { data: stats } = useGetStats({ query: { enabled: isAdmin } });

  const createMarker = useCreateMarker();
  const deleteMarker = useDeleteMarker();

  useEffect(() => {
    if (!mapContainer.current) return;
    if (mapRef.current) return;

    mapRef.current = L.map(mapContainer.current).setView([53.4285, 14.5528], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
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

  useEffect(() => {
    if (!mapRef.current) return;

    // Clear existing
    Object.values(markersRef.current).forEach(m => m.remove());
    markersRef.current = {};

    if (guestData) {
      const marker = L.marker([guestData.lat, guestData.lng], { icon: createIcon(goldCoinHtml) })
        .addTo(mapRef.current)
        .bindPopup(`
          <div class="p-2 text-center">
            <h3 class="font-bold text-lg text-amber-600">${guestData.markerTitle}</h3>
            <span class="inline-block mt-2 px-2 py-1 bg-amber-100 text-amber-800 rounded-full text-xs font-bold uppercase">Moneta znaleziona!</span>
          </div>
        `);
      markersRef.current[guestData.markerId] = marker;
      mapRef.current.flyTo([guestData.lat, guestData.lng], 16);
      marker.openPopup();
    } else if (isAdmin) {
      markers.forEach(m => {
        const isExpired = new Date(m.expiresAt) < new Date();
        const marker = L.marker([m.lat, m.lng], { icon: createIcon(isExpired ? expiredPinHtml : adminPinHtml) })
          .addTo(mapRef.current!)
          .bindPopup(`
            <div class="p-2 min-w-[200px]">
              <h3 class="font-bold text-lg">${m.title}</h3>
              <p class="text-sm text-gray-600 mt-1">${m.description}</p>
              <div class="mt-2 bg-gray-100 p-2 rounded text-center">
                <code class="font-mono font-bold tracking-widest text-primary">${m.code}</code>
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

    createMarker.mutate({
      data: {
        title: newTitle,
        description: newDesc,
        lat: clickPos.lat,
        lng: clickPos.lng,
        imageUrl: newImg
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMarkersQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
        toast({ title: "Skarb dodany!" });
        showSaved();
        setIsSheetOpen(false);
        setNewTitle("");
        setNewDesc("");
        setNewImg(null);
      }
    });
  };

  const handleDeleteMarker = (id: number) => {
    deleteMarker.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMarkersQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
        toast({ title: "Skarb usunięty" });
        showSaved();
      }
    });
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setNewImg(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const flyToMarker = (lat: number, lng: number, id: number) => {
    mapRef.current?.flyTo([lat, lng], 18);
    setTimeout(() => {
      markersRef.current[id]?.openPopup();
    }, 500);
  };

  return (
    <div className="flex flex-col h-[100dvh] w-full relative">
      {/* Topbar */}
      <header className="h-16 flex items-center justify-between px-4 bg-white border-b shadow-sm z-[1000] relative shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🪙</span>
          <h1 className="font-bold text-lg hidden sm:block text-green-950">Treasure Hunt</h1>
          <Badge variant="outline" className={isAdmin ? "bg-amber-100 text-amber-800 border-amber-200" : "bg-blue-100 text-blue-800 border-blue-200"}>
            {isAdmin ? <Shield className="w-3 h-3 mr-1" /> : <User className="w-3 h-3 mr-1" />}
            {isAdmin ? "Admin" : "Odkrywca"}
          </Badge>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-600 hidden sm:block">
            {isAdmin ? user?.name : guestData?.markerTitle}
          </span>
          <Button variant="ghost" size="sm" onClick={onLogout} className="text-red-600 hover:text-red-700 hover:bg-red-50">
            <LogOut className="w-4 h-4 mr-2" /> Wyloguj
          </Button>
        </div>
      </header>

      {/* Map Container */}
      <div className="flex-1 relative bg-slate-100 z-0">
        <div id="map" ref={mapContainer} className="absolute inset-0 w-full h-full" />

        {/* Admin Side Panel */}
        {isAdmin && (
          <div className="absolute top-4 right-4 w-80 max-h-[calc(100%-2rem)] flex flex-col gap-4 z-[1000] pointer-events-none">
            {stats && (
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
                  <Button variant="ghost" size="icon" className="w-6 h-6" onClick={() => queryClient.invalidateQueries({ queryKey: getListMarkersQueryKey() })}>
                    <RefreshCcw className="w-3 h-3 text-green-700" />
                  </Button>
                </div>
              </div>
              <ScrollArea className="flex-1 p-2">
                <div className="space-y-2">
                  {markers.map(m => {
                    const isExpired = new Date(m.expiresAt) < new Date();
                    return (
                      <div key={m.id} className={`p-3 rounded-md border text-sm transition-colors cursor-pointer group ${isExpired ? 'bg-gray-50 border-gray-100' : 'bg-white hover:border-green-300 hover:shadow-sm'}`} onClick={() => flyToMarker(m.lat, m.lng, m.id)}>
                        <div className="flex justify-between items-start mb-1">
                          <span className={`font-semibold ${isExpired ? 'text-gray-500' : 'text-green-900'}`}>
                            {m.title} {isExpired && "(Wygasły)"}
                          </span>
                          <Button variant="ghost" size="icon" className="w-6 h-6 text-red-400 hover:text-red-700 hover:bg-red-50" onClick={(e) => { e.stopPropagation(); handleDeleteMarker(m.id); }}>
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                        <div className="flex items-center gap-2 mt-2">
                          <code className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded text-xs font-mono font-bold tracking-widest">{m.code}</code>
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
          </div>
        )}

      </div>

      {/* Admin Create Sheet */}
      <Sheet open={isSheetOpen} onOpenChange={setIsSheetOpen}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto sm:max-w-md sm:mx-auto rounded-t-xl">
          <SheetHeader>
            <SheetTitle>Ukryj nowy skarb</SheetTitle>
            <SheetDescription>Wprowadź dane skarbu. Kod zostanie wygenerowany automatycznie.</SheetDescription>
          </SheetHeader>
          <form onSubmit={handleCreateMarker} className="mt-4 space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Nazwa</label>
              <Input value={newTitle} onChange={e => setNewTitle(e.target.value)} required placeholder="np. Złoty Graal na Wałach" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Wskazówka (opis)</label>
              <Textarea value={newDesc} onChange={e => setNewDesc(e.target.value)} required placeholder="Idź wzdłuż rzeki aż zobaczysz..." className="resize-none" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Zdjęcie (opcjonalne)</label>
              <div className="flex items-center gap-4">
                <Button type="button" variant="outline" className="w-full" onClick={() => document.getElementById('img-upload')?.click()}>
                  <ImageIcon className="w-4 h-4 mr-2" /> Wybierz zdjęcie
                </Button>
                <input id="img-upload" type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
              </div>
              {newImg && (
                <div className="mt-2 rounded-md overflow-hidden h-32 relative border">
                  <img src={newImg} alt="Preview" className="object-cover w-full h-full" />
                </div>
              )}
            </div>
            <Button type="submit" className="w-full bg-green-600 hover:bg-green-700" disabled={createMarker.isPending || !newTitle || !newDesc}>
              {createMarker.isPending ? "Zapisywanie..." : "Ukryj skarb"}
            </Button>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}

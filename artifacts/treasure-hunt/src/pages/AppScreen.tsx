import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getGetStatsQueryKey,
  getListMarkersQueryKey,
  useCreateMarker,
  useDeleteMarker,
  useGetStats,
  useListMarkers,
} from "@workspace/api-client-react";
import type { Marker, Stats } from "@workspace/api-client-react";
import type { CreatorPinPackageId } from "@workspace/api-zod/pin-packages";
import { useQueryClient } from "@tanstack/react-query";
import type { GuestData } from "@/App";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import CreatorDashboard from "@/pages/CreatorDashboard";
import CreatorMap, { type CreatorMapHandle } from "@/pages/CreatorMap";
import PinPackagesDialog from "@/pages/PinPackagesDialog";
import { Check, Image as ImageIcon, Loader2, X } from "lucide-react";
import { copyToClipboard, processImageFile } from "@/pages/map-shared";

type AppScreenProps = {
  user: { id: number; name: string; role: string; slug?: string; pinBalance?: number; firstPurchaseBonusGranted?: boolean; canAccessAnalytics?: boolean } | null;
  guestData: GuestData | null;
  onLogout: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  loginMsg: string | null;
  onLoginMsgDismiss: () => void;
  layoutPreview?: boolean;
};

type PickedPoint = { index: number; lat: number; lng: number; nonce: number };

export default function AppScreen({ user, guestData, onLogout, theme, onToggleTheme, loginMsg, onLoginMsgDismiss, layoutPreview = false }: AppScreenProps) {
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const mapRef = useRef<CreatorMapHandle>(null);
  const isAdmin = user?.role === "admin" || user?.role === "moderator" || user?.role === "master_admin";
  const isCreator = user?.role === "admin";
  const [pinBalance, setPinBalance] = useState<number | null>(user?.pinBalance ?? null);
  const [firstPurchaseBonusGranted, setFirstPurchaseBonusGranted] = useState(user?.firstPurchaseBonusGranted ?? false);
  const [pinPurchaseOpen, setPinPurchaseOpen] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState<CreatorPinPackageId | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [paymentPending, setPaymentPending] = useState(false);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [clickPos, setClickPos] = useState<{ lat: number; lng: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickTarget, setPickTarget] = useState<"marker" | number | null>(null);
  const [picked, setPicked] = useState<PickedPoint | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newImg, setNewImg] = useState<string | null>(null);
  const [imgProcessing, setImgProcessing] = useState(false);
  const [imgUploadedFlash, setImgUploadedFlash] = useState(false);
  const [selectedMarkerId, setSelectedMarkerId] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mapMarkers, setMapMarkers] = useState<Marker[]>([]);

  const previewMarkers = useMemo<Marker[]>(() => {
    const now = Date.now();
    return [
      { id: -1, title: "Złote jajko przy Wałach", description: "Szukaj przy dużym drzewie.", code: "ZL0TE", lat: 53.4288, lng: 14.5526, imageUrl: null, hasImage: false, createdAt: new Date(now - 3_600_000).toISOString(), expiresAt: new Date(now + 2_870_000).toISOString(), activatedAt: new Date(now - 730_000).toISOString(), redemptionCount: 1 },
      { id: -2, title: "Tajemnicza skrzynka", description: "Rozejrzyj się w pobliżu fontanny.", code: "SK4RB", lat: 53.4323, lng: 14.5591, imageUrl: null, hasImage: false, createdAt: new Date(now - 7_200_000).toISOString(), expiresAt: null, activatedAt: null, redemptionCount: 0 },
      { id: -3, title: "Skarb podróżnika", description: "Podążaj za wskazówką.", code: "PODR1", lat: 53.4247, lng: 14.5452, imageUrl: null, hasImage: false, createdAt: new Date(now - 86_400_000).toISOString(), expiresAt: new Date(now - 3_600_000).toISOString(), activatedAt: new Date(now - 4_200_000).toISOString(), redemptionCount: 1 },
    ];
  }, []);
  const emptyMarkers = useMemo<Marker[]>(() => [], []);
  const { data: liveMarkers } = useListMarkers({ query: { queryKey: getListMarkersQueryKey(), enabled: isAdmin && !layoutPreview } });
  const markers = layoutPreview ? previewMarkers : (liveMarkers ?? emptyMarkers);
  const { data: liveStats } = useGetStats({ query: { queryKey: getGetStatsQueryKey(), enabled: isAdmin && !layoutPreview } });
  const stats: Stats | undefined = layoutPreview ? { totalMarkers: 3, activeMarkers: 2, expiredMarkers: 1, totalRedemptions: 2 } : liveStats;
  const createMarker = useCreateMarker();
  const deleteMarker = useDeleteMarker();

  useEffect(() => { setSidebarCollapsed(isMobile); }, [isMobile]);
  useEffect(() => {
    if (!loginMsg) return;
    const id = window.setTimeout(() => onLoginMsgDismiss(), 3000);
    return () => window.clearTimeout(id);
  }, [loginMsg, onLoginMsgDismiss]);

  const handlePinCheckout = async (packageId: CreatorPinPackageId) => {
    setCheckoutError(null);
    setCheckoutBusy(packageId);
    try {
      const response = await fetch("/api/payments/checkout-session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ packageId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Nie udało się rozpocząć płatności.");
      const checkoutUrl = new URL(result.url);
      if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.stripe.com") {
        throw new Error("Otrzymany adres płatności Stripe jest nieprawidłowy.");
      }
      window.location.assign(checkoutUrl.toString());
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Nie udało się rozpocząć płatności.");
      setCheckoutBusy(null);
    }
  };

  useEffect(() => {
    if (!user || user.role !== "admin" || layoutPreview) return;
    const url = new URL(window.location.href);
    const paymentResult = url.searchParams.get("payment");
    const sessionId = url.searchParams.get("session_id");
    const clearPaymentQuery = () => {
      url.searchParams.delete("payment");
      url.searchParams.delete("session_id");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    };
    if (paymentResult === "cancelled") {
      setPinPurchaseOpen(true);
      toast({ title: "Płatność anulowana", description: "Nie pobrano opłaty. Możesz wybrać pakiet ponownie." });
      clearPaymentQuery();
      return;
    }
    if (paymentResult !== "success" || !sessionId) return;
    let attempts = 0;
    let timer: number | undefined;
    let stopped = false;
    const checkPayment = async () => {
      try {
        const response = await fetch(`/api/payments/checkout-session/${encodeURIComponent(sessionId)}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
        if (response.ok) {
          const result = await response.json();
          if (result.status === "paid") {
            if (stopped) return;
            setPinBalance(result.pinBalance);
            setFirstPurchaseBonusGranted(Boolean(result.firstPurchaseBonusGranted));
            setPaymentPending(false);
            toast({ title: "Płatność potwierdzona", description: result.bonusPins > 0 ? `Dodano ${result.bonusPins} pinezek bonusowych. Saldo obejmuje pakiet i bonus.` : "Nowe pinezki zostały dodane do Twojego konta." });
            clearPaymentQuery();
            return;
          }
          if (result.status === "failed" || result.status === "expired") {
            if (stopped) return;
            setPaymentPending(false);
            setPinPurchaseOpen(true);
            setCheckoutError(result.status === "expired" ? "Sesja płatności wygasła. Wybierz pakiet ponownie." : "Płatność nie została zrealizowana. Możesz spróbować ponownie.");
            clearPaymentQuery();
            return;
          }
        }
      } catch {
        // The Stripe webhook may still be processing.
      }
      attempts += 1;
      if (stopped) return;
      if (attempts >= 20) {
        setPaymentPending(true);
        setPinPurchaseOpen(true);
        toast({ title: "Płatność jest potwierdzana", description: "Saldo zaktualizuje się po potwierdzeniu przez Stripe. Odśwież stronę za chwilę." });
        return;
      }
      timer = window.setTimeout(checkPayment, 1500);
    };
    void checkPayment();
    return () => { stopped = true; if (timer) window.clearTimeout(timer); };
  }, [user?.id, user?.role, layoutPreview, toast]);

  const startMarkerPick = () => {
    setPickTarget("marker");
    setPicking(true);
    if (isMobile) setSidebarCollapsed(true);
  };
  const onMarkerClick = useCallback((id: number) => setSelectedMarkerId(id), []);
  const onVisibleMarkers = useCallback((next: Marker[]) => {
    setMapMarkers((current) => (
      current.length === next.length && current.every((marker, index) => marker.id === next[index]?.id && marker.expiresAt === next[index]?.expiresAt && marker.title === next[index]?.title)
        ? current
        : next
    ));
  }, []);

  const handleCreateMarker = (event: React.FormEvent) => {
    event.preventDefault();
    if (layoutPreview || !clickPos || !newTitle || !newDesc) return;
    createMarker.mutate(
      { data: { title: newTitle, description: newDesc, lat: clickPos.lat, lng: clickPos.lng, imageUrl: newImg } },
      {
        onSuccess: async (created) => {
          queryClient.invalidateQueries({ queryKey: getListMarkersQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
          if (isCreator) setPinBalance((balance) => balance == null ? balance : Math.max(0, balance - 1));
          setSaved(true);
          window.setTimeout(() => setSaved(false), 2000);
          const copied = await copyToClipboard(created.code);
          toast({ title: "Skarb dodany!", description: copied ? `Kod ${created.code} skopiowany do schowka` : `Kod: ${created.code}` });
          setIsSheetOpen(false);
          setNewTitle("");
          setNewDesc("");
          setNewImg(null);
        },
        onError: (error) => {
          if ((error as { status?: number }).status === 402) setPinPurchaseOpen(true);
        },
      },
    );
  };

  const handleDeleteMarker = (id: number) => {
    if (layoutPreview) return;
    deleteMarker.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMarkersQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
        toast({ title: "Skarb usunięty" });
        setSaved(true);
        window.setTimeout(() => setSaved(false), 2000);
      },
    });
  };

  return (
    <div className="relative flex h-[100dvh] w-full flex-col">
      <CreatorMap
        ref={mapRef}
        isAdmin={Boolean(isAdmin)}
        theme={theme}
        guestData={guestData}
        markers={isAdmin ? mapMarkers : []}
        picking={picking}
        pickingLabel={typeof pickTarget === "number" ? "Wskaż miejsce punktu, klikając mapę." : "Wskaż miejsce skarbu, klikając mapę."}
        onCancelPick={() => { setPicking(false); setPickTarget(null); }}
        onPick={(lat, lng) => {
          if (typeof pickTarget === "number") setPicked({ index: pickTarget, lat, lng, nonce: Date.now() });
          else {
            setClickPos({ lat, lng });
            setIsSheetOpen(true);
          }
          setPicking(false);
          setPickTarget(null);
        }}
        onMarkerClick={onMarkerClick}
        onStartAdd={startMarkerPick}
        onToggleTheme={onToggleTheme}
        onLogout={onLogout}
        loginMsg={loginMsg}
      />
      {isAdmin && (
        <CreatorDashboard
          user={user}
          layoutPreview={layoutPreview}
          isMobile={isMobile}
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
          theme={theme}
          onToggleTheme={onToggleTheme}
          onLogout={onLogout}
          markers={markers}
          stats={stats}
          saved={saved}
          selectedMarkerId={selectedMarkerId}
          onVisibleMarkers={onVisibleMarkers}
          onFly={(lat, lng, id) => { setSelectedMarkerId(id); mapRef.current?.flyTo(lat, lng); mapRef.current?.openPopup(id); }}
          onDelete={handleDeleteMarker}
          onCopy={async (code) => {
            const ok = await copyToClipboard(code);
            toast({ title: ok ? "Kod skopiowany" : "Nie udało się skopiować", description: ok ? `${code} jest w schowku` : "Spróbuj skopiować ręcznie.", variant: ok ? "default" : "destructive" });
          }}
          onRefresh={() => queryClient.invalidateQueries({ queryKey: getListMarkersQueryKey() })}
          onStartAdd={startMarkerPick}
          pinBalance={pinBalance}
          firstPurchaseBonusGranted={firstPurchaseBonusGranted}
          paymentPending={paymentPending}
          checkoutError={checkoutError}
          onOpenPackages={() => setPinPurchaseOpen(true)}
          picked={picked}
          onRequestPick={(index) => { setPickTarget(index); setPicking(true); if (isMobile) setSidebarCollapsed(true); }}
          onNeedPins={() => setPinPurchaseOpen(true)}
          onPublished={(balance, charged) => { if (charged) setPinBalance(balance); }}
        />
      )}
      <Sheet open={isSheetOpen} onOpenChange={setIsSheetOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-xl sm:mx-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Ukryj nowy skarb</SheetTitle>
            <SheetDescription>Wprowadź dane skarbu. Kod zostanie wygenerowany automatycznie i skopiowany do schowka.</SheetDescription>
          </SheetHeader>
          <form onSubmit={handleCreateMarker} className="mt-4 space-y-4">
            {clickPos && (
              <div className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200">
                <span>Miejsce wybrane na mapie</span>
                <button type="button" className="font-semibold underline" onClick={() => { setIsSheetOpen(false); startMarkerPick(); }}>Zmień miejsce</button>
              </div>
            )}
            <Input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} required placeholder="np. Złoty Graal na Wałach" aria-label="Nazwa" />
            <Textarea value={newDesc} onChange={(event) => setNewDesc(event.target.value)} required placeholder="Idź wzdłuż rzeki aż zobaczysz..." className="resize-none" aria-label="Wskazówka" />
            <input id="img-upload" type="file" accept="image/*" className="hidden" onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setImgProcessing(true);
              try {
                setNewImg(await processImageFile(file));
                setImgUploadedFlash(true);
                window.setTimeout(() => setImgUploadedFlash(false), 2000);
              } catch {
                toast({ variant: "destructive", title: "Błąd zdjęcia", description: "Nie można przetworzyć obrazu." });
              } finally {
                setImgProcessing(false);
                event.target.value = "";
              }
            }} />
            {newImg ? (
              <div className="space-y-2">
                <img src={newImg} alt="Podgląd zdjęcia skarbu" className="h-32 w-full rounded-md object-cover" />
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => document.getElementById("img-upload")?.click()}><ImageIcon className="mr-1 h-3 w-3" />Zmień zdjęcie</Button>
                  <Button type="button" variant="outline" size="sm" className="flex-1 text-red-600" onClick={() => setNewImg(null)}><X className="mr-1 h-3 w-3" />Usuń zdjęcie</Button>
                </div>
              </div>
            ) : (
              <Button type="button" variant="outline" className="w-full" onClick={() => document.getElementById("img-upload")?.click()} disabled={imgProcessing}>
                {imgProcessing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : imgUploadedFlash ? <Check className="mr-2 h-4 w-4 text-green-600" /> : <ImageIcon className="mr-2 h-4 w-4" />}
                {imgProcessing ? "Kompresja…" : "Wybierz zdjęcie"}
              </Button>
            )}
            <Button type="submit" className="w-full bg-green-600 hover:bg-green-700" disabled={createMarker.isPending || !newTitle || !newDesc || imgProcessing}>
              {createMarker.isPending ? "Zapisywanie..." : "Ukryj skarb"}
            </Button>
          </form>
        </SheetContent>
      </Sheet>
      <PinPackagesDialog
        open={pinPurchaseOpen}
        onOpenChange={setPinPurchaseOpen}
        firstPurchaseBonusGranted={firstPurchaseBonusGranted}
        checkoutBusy={checkoutBusy}
        checkoutError={checkoutError}
        onCheckout={(packageId) => void handlePinCheckout(packageId)}
      />
    </div>
  );
}

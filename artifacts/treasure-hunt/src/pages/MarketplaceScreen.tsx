import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MapPin, Navigation, Search, Send, TicketCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Offer = {
  id: number; creatorName: string; title: string; description: string;
  category: string | null; imageUrl: string | null; lat: number; lng: number;
  priceCents: number; currency: string; availableQuantity: number; pickupDetails: string;
  pickupUntil: string | null; distanceKm?: number; creatorPositive?: number; creatorNegative?: number; creatorRatingCount?: number; creatorBadge?: string;
};
type Reservation = {
  id: number; status: string; priceCents: number; currency: string;
  paymentStatus?: string; grossAmountCents?: number; platformFeeCents?: number; creatorNetCents?: number; pickupCode?: string | null;
  responseDeadline: string; pickupExpiresAt: string | null; requestedAt: string;
  offerTitle: string; pickupDetails: string;
};
type Proposal = { id: number; message: string; creatorName: string; offerTitle: string; priceCents: number; createdAt: string; reservationId?: number | null; reservationStatus?: string | null; paymentStatus?: string | null };
type SearchRequest = { id: number; category: string | null; description: string; budgetCents: number | null; radiusKm: number; neededBy: string | null; status: string; proposals: Proposal[] };

const money = (cents: number) => `${(cents / 100).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const time = (value: string | null) => value ? new Date(value).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" }) : "Do uzgodnienia";
function safeImageUrl(value: string | null): string | null {
  if (!value) return null;
  if (/^data:image\/jpeg;base64,[A-Za-z0-9+/]*={0,2}$/.test(value)) return value;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? value : null; }
  catch { return null; }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init, credentials: "same-origin",
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? "Nie udało się wykonać tej czynności.");
  return data as T;
}

export default function MarketplaceScreen({ embedded = false, onBackHome }: { embedded?: boolean; onBackHome?: () => void }) {
  const mapElement = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [radiusKm, setRadiusKm] = useState("0.5");
  const [offers, setOffers] = useState<Offer[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [requests, setRequests] = useState<SearchRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [budget, setBudget] = useState("");
  const [neededBy, setNeededBy] = useState("");

  const loadVisitorData = useCallback(async () => {
    try {
      const [reservationRows, requestRows] = await Promise.all([
        api<Reservation[]>("/api/marketplace/mine/reservations/guest"),
        api<SearchRequest[]>("/api/marketplace/requests/guest"),
      ]);
      setReservations(reservationRows);
      setRequests(requestRows);
    } catch { /* keep current view; the next refresh can recover */ }
  }, []);

  useEffect(() => {
    if (!mapElement.current || mapRef.current) return;
    const map = L.map(mapElement.current, { scrollWheelZoom: false }).setView([52, 19], 6);
    L.tileLayer("/api/map-tiles/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap contributors",
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    map.on("click", (event) => {
      setLat(event.latlng.lat.toFixed(5));
      setLng(event.latlng.lng.toFixed(5));
      setNotice("Lokalizacja wyszukiwania została ustawiona na mapie.");
    });
    // The map is mounted after the page transition and can initially measure
    // as hidden. Recalculate its size so the first tile request is rendered
    // without requiring the visitor to enter coordinates first.
    requestAnimationFrame(() => {
      map.setView([52, 19], 6, { animate: false });
      map.invalidateSize();
    });
    const resizeTimer = window.setTimeout(() => {
      map.setView([52, 19], 6, { animate: false });
      map.invalidateSize();
    }, 250);
    mapRef.current = map;
    return () => { window.clearTimeout(resizeTimer); map.remove(); mapRef.current = null; layerRef.current = null; };
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    const map = mapRef.current;
    if (!layer || !map) return;
    layer.clearLayers();
    for (const offer of offers) {
      const marker = L.marker([offer.lat, offer.lng]).addTo(layer);
      const popup = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = offer.title;
      const price = document.createElement("p");
      price.textContent = money(offer.priceCents);
      popup.append(title, price);
      marker.bindPopup(popup);
    }
    const latitude = Number(lat), longitude = Number(lng);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      map.setView([latitude, longitude], Math.max(map.getZoom(), 10));
    } else if (offers.length) {
      const bounds = L.latLngBounds(offers.map((offer) => [offer.lat, offer.lng] as [number, number]));
      map.fitBounds(bounds.pad(0.12), { maxZoom: 13 });
    }
  }, [offers, lat, lng]);

  useEffect(() => {
    void loadVisitorData();
    const timer = window.setInterval(() => void loadVisitorData(), 20_000);
    return () => window.clearInterval(timer);
  }, [loadVisitorData]);

  const search = async () => {
    const latitude = Number(lat), longitude = Number(lng);
    if (!lat || !lng || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      setError("Wybierz miejsce na mapie, wpisz współrzędne albo użyj swojej lokalizacji.");
      return;
    }
    setLoading(true); setError(null); setNotice(null);
    try {
      const rows = await api<Offer[]>(`/api/marketplace/offers?lat=${encodeURIComponent(latitude)}&lng=${encodeURIComponent(longitude)}&radiusKm=${encodeURIComponent(radiusKm)}`);
      setOffers(rows);
      await loadVisitorData();
      setNotice(`Znaleziono ${rows.length} ${rows.length === 1 ? "ofertę" : "ofert"} w wybranym promieniu.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się wyszukać ofert."); }
    finally { setLoading(false); }
  };

  const locate = useCallback(() => {
    if (!navigator.geolocation) { setError("Ta przeglądarka nie udostępnia lokalizacji."); return; }
    setNotice("Pobieram Twoją lokalizację…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latitude = position.coords.latitude.toFixed(5);
        const longitude = position.coords.longitude.toFixed(5);
        setLat(latitude);
        setLng(longitude);
        mapRef.current?.setView([Number(latitude), Number(longitude)], 13);
        setError(null);
        setNotice("Mapa została ustawiona w Twojej bieżącej lokalizacji. Wybierz „Szukaj”, aby zobaczyć skarby w pobliżu.");
      },
      () => {
        setNotice(null);
        setError("Nie uzyskano dostępu do lokalizacji. Wybierz miejsce kliknięciem na mapie albo wpisz je ręcznie.");
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }, []);

  // Przy pierwszym otwarciu używamy GPS jako domyślnego punktu mapy. Nie
  // zapisujemy tej lokalizacji na serwerze; użytkownik może ją zastąpić
  // kliknięciem na mapie lub ręcznym wpisaniem współrzędnych.
  useEffect(() => {
    locate();
  }, [locate]);

  const reserve = async (offer: Offer) => {
    setError(null); setNotice(null);
    try {
      const result = await api<{ id: number; message: string }>("/api/marketplace/reservations", { method: "POST", body: JSON.stringify({ offerId: offer.id }) });
      await Promise.all([search(), loadVisitorData()]);
      setNotice(`Prośba o rezerwację #${result.id} wysłana. ${result.message}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się wysłać rezerwacji."); }
  };

  const startCheckout = async (id: number) => {
    setError(null); setNotice(null);
    try {
      const result = await api<{ url: string }>(`/api/marketplace/reservations/${id}/checkout`, { method: "POST", body: JSON.stringify({}) });
      window.location.href = result.url;
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się rozpocząć płatności."); }
  };

  const acceptProposal = async (request: SearchRequest, proposal: Proposal) => {
    setError(null); setNotice(null);
    try {
      const result = await api<{ reservationId: number; status: string; paymentRequired: boolean; url?: string }>(
        `/api/marketplace/requests/${request.id}/proposals/${proposal.id}/checkout`,
        { method: "POST", body: JSON.stringify({}) },
      );
      if (result.url) {
        window.location.href = result.url;
        return;
      }
      await loadVisitorData();
      setNotice("Propozycja została przyjęta. Odbiorca może przekazać kod po znalezieniu skarbu.");
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się przyjąć propozycji."); }
  };

  const rateReservation = async (id: number, vote: 1 | -1) => {
    try {
      await api(`/api/marketplace/reservations/${id}/rating`, { method: "POST", body: JSON.stringify({ vote }) });
      setNotice("Dziękujemy za ocenę Kreatora.");
      await loadVisitorData();
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się zapisać oceny."); }
  };

  const cancelReservation = async (id: number) => {
    try {
      await api(`/api/marketplace/reservations/${id}/cancel`, { method: "POST", body: JSON.stringify({}) });
      setNotice(`Rezerwacja #${id} została anulowana.`);
      await Promise.all([loadVisitorData(), search()]);
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się anulować rezerwacji."); }
  };

  const sendRequest = async (event: React.FormEvent) => {
    event.preventDefault(); setError(null); setNotice(null);
    try {
      await api("/api/marketplace/requests", {
        method: "POST",
        body: JSON.stringify({ category, description, budgetPln: budget || null, lat: Number(lat), lng: Number(lng), neededBy: neededBy || null }),
      });
      setDescription(""); setBudget(""); setNeededBy(""); setRequestOpen(false);
      setNotice("Zapytanie zostało dodane. Pasujący Kreatorzy mogą wysłać propozycję.");
      await loadVisitorData();
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się dodać zapytania."); }
  };

  const canSearch = useMemo(() => Boolean(lat && lng), [lat, lng]);

  return (
    <main className="min-h-screen bg-slate-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="flex items-center justify-between border-b bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900 sm:px-8">
        {embedded ? <button type="button" onClick={onBackHome} className="font-bold text-green-900 underline dark:text-green-300">Wpisz token</button> : <a href="/" className="font-bold text-green-900 dark:text-green-300">Pysne.com.pl</a>}
        <a href="/panel" className="text-sm font-medium text-green-800 underline dark:text-green-300">Panel Kreatora</a>
      </header>
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-8">
        <section className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-700 dark:text-amber-400">Lokalne oferty</p>
          <h1 className="text-2xl font-bold sm:text-3xl">Znajdź skarb w swojej okolicy</h1>
          <p className="max-w-3xl text-sm text-gray-600 dark:text-gray-300">Przeglądaj oferty bez zakładania konta. Wybierz miejsce kliknięciem na mapie, wpisz współrzędne albo pozwól przeglądarce udostępnić lokalizację. Tokeny do gier nadal wpisuje się na stronie głównej.</p>
        </section>

        <section className="grid gap-4 rounded-2xl border bg-white p-4 dark:border-gray-800 dark:bg-gray-900 md:grid-cols-[1fr_1fr_auto_auto] md:items-end">
          <label className="space-y-1 text-sm font-medium">Szerokość geograficzna<Input inputMode="decimal" value={lat} onChange={(event) => setLat(event.target.value)} placeholder="Kliknij mapę lub użyj lokalizacji" /></label>
          <label className="space-y-1 text-sm font-medium">Długość geograficzna<Input inputMode="decimal" value={lng} onChange={(event) => setLng(event.target.value)} placeholder="np. 21.0122" /></label>
          <label className="space-y-1 text-sm font-medium">Promień wyszukiwania<select className="h-10 w-full rounded-md border bg-background px-3" value={radiusKm} onChange={(event) => setRadiusKm(event.target.value)}>{[0.5, 1, 2, 5, 10, 20, 50].map((n) => <option key={n} value={n}>{n === 0.5 ? "500 m" : `${n} km`}</option>)}</select></label>
          <div className="flex gap-2 md:justify-end"><Button type="button" variant="outline" onClick={locate} aria-label="Użyj mojej lokalizacji"><Navigation className="mr-2 h-4 w-4" />Moja lokalizacja</Button><Button type="button" onClick={() => void search()} disabled={loading || !canSearch}><Search className="mr-2 h-4 w-4" />Szukaj</Button></div>
          <p className="md:col-span-4 text-xs text-gray-500 dark:text-gray-400">Wskazówka: kliknij na mapie, aby ustawić punkt wyszukiwania. Lokalizacja Odbiorcy nie jest zapisywana przy szukaniu ofert.</p>
        </section>

        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">{error}</p>}
        {notice && <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">{notice}</p>}

        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-3">
            <h2 className="text-lg font-semibold">Mapa ofert</h2>
            <div ref={mapElement} className="h-[360px] overflow-hidden rounded-2xl border bg-gray-100 dark:border-gray-800" aria-label="Mapa ofert. Kliknij, aby ustawić miejsce wyszukiwania." />
          </div>
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Oferty w pobliżu</h2><span className="text-sm text-gray-500">{offers.length}</span></div>
            {offers.length === 0 ? <p className="rounded-xl border border-dashed p-6 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">Ustaw miejsce i promień, a następnie wybierz „Szukaj”.</p> : <div className="max-h-[360px] space-y-3 overflow-y-auto pr-1">
              {offers.map((offer) => <article key={offer.id} className="space-y-3 rounded-2xl border bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
                <div className="flex gap-3">{safeImageUrl(offer.imageUrl) && <img src={safeImageUrl(offer.imageUrl) ?? undefined} alt="" className="h-20 w-20 rounded-lg object-cover" />}<div className="min-w-0 flex-1"><h3 className="font-semibold">{offer.title}</h3><p className="text-sm text-gray-600 dark:text-gray-300">{offer.description}</p><p className="mt-1 text-xs text-gray-500">Kreator: {offer.creatorName}{offer.distanceKm != null ? ` · ${offer.distanceKm.toFixed(1)} km` : ""} · Dostępne: {offer.availableQuantity}</p><p className="text-xs text-amber-700 dark:text-amber-300">{offer.creatorBadge === "Zaufany" ? "🏆" : offer.creatorBadge === "Sprawdzony" ? "⭐" : offer.creatorBadge === "Bardzo wiarygodny" ? "🏆" : "🟢"} {offer.creatorBadge ?? "Nowy Kreator"}{(offer.creatorRatingCount ?? 0) > 0 ? ` · 👍 ${offer.creatorPositive ?? 0} · 👎 ${offer.creatorNegative ?? 0}` : ""}</p></div></div>
                <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-lg text-green-800 dark:text-green-300">{money(offer.priceCents)}</strong><span className="text-xs text-gray-500">Odbiór: {time(offer.pickupUntil)}</span></div>
                <p className="text-sm text-gray-700 dark:text-gray-300"><MapPin className="mr-1 inline h-4 w-4" />{offer.pickupDetails}</p>
                <Button type="button" className="w-full" onClick={() => void reserve(offer)}><TicketCheck className="mr-2 h-4 w-4" />Chcę ten skarb</Button>
              </article>)}
            </div>}
          </section>
        </div>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-3 rounded-2xl border bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
            <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Moje rezerwacje</h2><span className="text-xs text-gray-500">Odświeżane automatycznie</span></div>
            {reservations.length === 0 ? <p className="text-sm text-gray-600 dark:text-gray-300">Po wysłaniu prośby o rezerwację jej status pojawi się tutaj w tej przeglądarce.</p> : reservations.map((reservation) => <div key={reservation.id} className="space-y-2 rounded-xl border p-3 dark:border-gray-700">
              <div className="flex items-center justify-between gap-2"><strong>{reservation.offerTitle} · {money(reservation.priceCents)}</strong><span className="text-xs font-semibold">{reservation.status}</span></div>
              <p className="text-xs text-gray-500">Odpowiedź do: {time(reservation.responseDeadline)}{reservation.pickupExpiresAt ? ` · Odbiór do: ${time(reservation.pickupExpiresAt)}` : ""}</p>
              {reservation.status === "accepted" && <div className="space-y-2"><p className="text-sm">Kreator przyjął rezerwację. Opłać ją, aby otrzymać kod odbioru.</p><Button size="sm" onClick={() => void startCheckout(reservation.id)}>Zapłać przez Stripe Checkout</Button></div>}
              {reservation.status === "pickup_ready" && <><p className="text-sm">Miejsce odbioru: {reservation.pickupDetails}</p><p className="text-sm font-semibold">Kod odbioru: {reservation.pickupCode ?? "Kod będzie dostępny po odświeżeniu."}</p></>}
              {reservation.status === "picked_up" && <div className="rounded-lg bg-green-50 p-3 text-sm dark:bg-green-950/30"><p>Odbiór zakończony. Oceń Kreatora:</p><div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => void rateReservation(reservation.id, 1)}>👍 Dobrze</Button><Button size="sm" variant="outline" onClick={() => void rateReservation(reservation.id, -1)}>👎 Źle</Button></div></div>}
              {(["requested", "accepted", "pickup_ready"].includes(reservation.status)) && <Button variant="outline" size="sm" onClick={() => void cancelReservation(reservation.id)}><X className="mr-2 h-4 w-4" />Anuluj rezerwację</Button>}
            </div>)}
          </div>

          <div className="space-y-3 rounded-2xl border bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
            <div className="flex items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Wybierz miejsce poszukiwań</h2><p className="text-sm text-gray-600 dark:text-gray-300">Wskaż punkt na mapie. Kreator może przygotować skarb w promieniu 500 m, a płatność nastąpi przed rozpoczęciem gry.</p></div><Button type="button" variant="outline" onClick={() => setRequestOpen((open) => !open)}>{requestOpen ? "Zamknij" : "Dodaj zapytanie"}</Button></div>
            {requestOpen && <form onSubmit={sendRequest} className="space-y-3 rounded-xl bg-slate-50 p-3 dark:bg-gray-800">
              <label className="block space-y-1 text-sm font-medium">Czego szukasz?<Textarea required minLength={10} maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Opisz skarb lub usługę" /></label>
              <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm font-medium">Kategoria<Input maxLength={50} value={category} onChange={(event) => setCategory(event.target.value)} placeholder="np. jedzenie, warsztat" /></label><label className="space-y-1 text-sm font-medium">Budżet (zł)<Input type="number" min="0" step="0.01" value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="opcjonalnie" /></label></div>
              <label className="block space-y-1 text-sm font-medium">Potrzebuję do<Input type="datetime-local" value={neededBy} onChange={(event) => setNeededBy(event.target.value)} /></label>
              <p className="text-xs text-gray-500">Kreator może umieścić skarb maksymalnie 500 m od wybranego punktu. Dokładna lokalizacja nie jest pokazywana przed płatnością.</p>
              <Button type="submit" disabled={!canSearch || description.trim().length < 10}><Send className="mr-2 h-4 w-4" />Wyślij zapytanie</Button>
            </form>}
            {requests.map((request) => <div key={request.id} className="space-y-2 rounded-xl border p-3 dark:border-gray-700"><p className="text-sm font-medium">{request.description}</p><p className="text-xs text-gray-500">Status: {request.status} · Promień 500 m{request.budgetCents != null ? ` · Budżet ${money(request.budgetCents)}` : ""}</p>{request.proposals.map((proposal) => <div key={proposal.id} className="rounded-lg bg-green-50 p-3 text-sm dark:bg-green-950/30"><strong>{proposal.creatorName}: {proposal.offerTitle}</strong><p>{proposal.message}</p><p className="font-semibold">{money(proposal.priceCents)}</p>{proposal.reservationId ? <p className="text-xs text-gray-600">Rezerwacja: {proposal.reservationStatus === "pickup_ready" ? "opłacona — kod jest dostępny poniżej" : proposal.reservationStatus}</p> : <><p className="text-xs text-gray-500">Kreator umieścił skarb w promieniu 500 m od Twojego punktu.</p><Button size="sm" onClick={() => void acceptProposal(request, proposal)}>{proposal.priceCents > 0 ? "Przyjmij i zapłać" : "Przyjmij propozycję"}</Button></>}</div>)}</div>)}
          </div>
        </section>
        <p className="text-xs text-gray-500">Płatność jest obsługiwana przez Stripe. Środki są przekazywane Kreatorowi po potwierdzeniu odbioru.</p>
      </div>
    </main>
  );
}

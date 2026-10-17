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
  pickupUntil: string | null; distanceKm?: number;
};
type Reservation = {
  id: number; status: string; priceCents: number; currency: string;
  responseDeadline: string; pickupExpiresAt: string | null; requestedAt: string;
  offerTitle: string; pickupDetails: string;
};
type Proposal = { id: number; message: string; creatorName: string; offerTitle: string; priceCents: number; createdAt: string };
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
  const [radiusKm, setRadiusKm] = useState("10");
  const [offers, setOffers] = useState<Offer[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [requests, setRequests] = useState<SearchRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickupCodes, setPickupCodes] = useState<Record<number, string>>({});
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
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap",
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    map.on("click", (event) => {
      setLat(event.latlng.lat.toFixed(5));
      setLng(event.latlng.lng.toFixed(5));
      setNotice("Lokalizacja wyszukiwania została ustawiona na mapie.");
    });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; layerRef.current = null; };
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

  const locate = () => {
    if (!navigator.geolocation) { setError("Ta przeglądarka nie udostępnia lokalizacji."); return; }
    navigator.geolocation.getCurrentPosition(
      (position) => { setLat(position.coords.latitude.toFixed(5)); setLng(position.coords.longitude.toFixed(5)); setError(null); setNotice("Lokalizacja została pobrana za Twoją zgodą. Teraz wybierz promień wyszukiwania."); },
      () => setError("Nie uzyskano dostępu do lokalizacji. Wybierz miejsce kliknięciem na mapie."),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  };

  const reserve = async (offer: Offer) => {
    setError(null); setNotice(null);
    try {
      const result = await api<{ id: number; pickupCode: string; message: string }>("/api/marketplace/reservations", { method: "POST", body: JSON.stringify({ offerId: offer.id }) });
      const nextCodes = { ...pickupCodes, [result.id]: result.pickupCode };
      setPickupCodes(nextCodes);
      try { localStorage.setItem("pysne_market_pickup_codes", JSON.stringify(nextCodes)); } catch { /* displayed once below */ }
      await Promise.all([search(), loadVisitorData()]);
      setNotice(`Prośba o rezerwację #${result.id} wysłana. ${result.message} Kod odbioru: ${result.pickupCode}.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się wysłać rezerwacji."); }
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
        body: JSON.stringify({ category, description, budgetPln: budget || null, lat: Number(lat), lng: Number(lng), radiusKm: Number(radiusKm), neededBy: neededBy || null }),
      });
      setDescription(""); setBudget(""); setNeededBy(""); setRequestOpen(false);
      setNotice("Zapytanie zostało dodane. Pasujący Kreatorzy mogą wysłać propozycję.");
      await loadVisitorData();
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się dodać zapytania."); }
  };

  const canSearch = useMemo(() => Boolean(lat && lng), [lat, lng]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("pysne_market_pickup_codes");
      if (saved) setPickupCodes(JSON.parse(saved) as Record<number, string>);
    } catch { /* ignore invalid local browser data */ }
  }, []);

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
          <label className="space-y-1 text-sm font-medium">Promień<select className="h-10 w-full rounded-md border bg-background px-3" value={radiusKm} onChange={(event) => setRadiusKm(event.target.value)}>{[1, 2, 5, 10, 20, 50].map((n) => <option key={n} value={n}>{n} km</option>)}</select></label>
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
                <div className="flex gap-3">{safeImageUrl(offer.imageUrl) && <img src={safeImageUrl(offer.imageUrl) ?? undefined} alt="" className="h-20 w-20 rounded-lg object-cover" />}<div className="min-w-0 flex-1"><h3 className="font-semibold">{offer.title}</h3><p className="text-sm text-gray-600 dark:text-gray-300">{offer.description}</p><p className="mt-1 text-xs text-gray-500">Kreator: {offer.creatorName}{offer.distanceKm != null ? ` · ${offer.distanceKm.toFixed(1)} km` : ""} · Dostępne: {offer.availableQuantity}</p></div></div>
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
              {reservation.status === "accepted" && <><p className="text-sm">Miejsce odbioru: {reservation.pickupDetails}</p><p className="text-sm font-semibold">Kod odbioru: {pickupCodes[reservation.id] ?? "Kod został pokazany po zgłoszeniu. Sprawdź zapisany komunikat."}</p></>}
              {(["requested", "accepted"].includes(reservation.status)) && <Button variant="outline" size="sm" onClick={() => void cancelReservation(reservation.id)}><X className="mr-2 h-4 w-4" />Anuluj rezerwację</Button>}
            </div>)}
          </div>

          <div className="space-y-3 rounded-2xl border bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
            <div className="flex items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Szukam skarbu</h2><p className="text-sm text-gray-600 dark:text-gray-300">Opisz, czego potrzebujesz. To zapytanie nie tworzy rezerwacji ani płatności.</p></div><Button type="button" variant="outline" onClick={() => setRequestOpen((open) => !open)}>{requestOpen ? "Zamknij" : "Dodaj zapytanie"}</Button></div>
            {requestOpen && <form onSubmit={sendRequest} className="space-y-3 rounded-xl bg-slate-50 p-3 dark:bg-gray-800">
              <label className="block space-y-1 text-sm font-medium">Czego szukasz?<Textarea required minLength={10} maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Opisz skarb lub usługę" /></label>
              <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm font-medium">Kategoria<Input maxLength={50} value={category} onChange={(event) => setCategory(event.target.value)} placeholder="np. jedzenie, warsztat" /></label><label className="space-y-1 text-sm font-medium">Budżet (zł)<Input type="number" min="0" step="0.01" value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="opcjonalnie" /></label></div>
              <label className="block space-y-1 text-sm font-medium">Potrzebuję do<Input type="datetime-local" value={neededBy} onChange={(event) => setNeededBy(event.target.value)} /></label>
              <p className="text-xs text-gray-500">Zostanie użyta wybrana lokalizacja i promień {radiusKm} km. Dla prywatności obszar jest zaokrąglany.</p>
              <Button type="submit" disabled={!canSearch || description.trim().length < 10}><Send className="mr-2 h-4 w-4" />Wyślij zapytanie</Button>
            </form>}
            {requests.map((request) => <div key={request.id} className="space-y-2 rounded-xl border p-3 dark:border-gray-700"><p className="text-sm font-medium">{request.description}</p><p className="text-xs text-gray-500">Status: {request.status} · Promień {request.radiusKm} km{request.budgetCents != null ? ` · Budżet ${money(request.budgetCents)}` : ""}</p>{request.proposals.map((proposal) => <div key={proposal.id} className="rounded-lg bg-green-50 p-3 text-sm dark:bg-green-950/30"><strong>{proposal.creatorName}: {proposal.offerTitle}</strong><p>{proposal.message}</p><p className="font-semibold">{money(proposal.priceCents)}</p><p className="text-xs text-gray-500">To propozycja — nie utworzyła rezerwacji ani płatności.</p></div>)}</div>)}
          </div>
        </section>
        <p className="text-xs text-gray-500">Rezerwacja nie pobiera opłaty online. Płatność marketplace i wypłata po odbiorze wymagają osobnej, zatwierdzonej integracji operatora.</p>
      </div>
    </main>
  );
}

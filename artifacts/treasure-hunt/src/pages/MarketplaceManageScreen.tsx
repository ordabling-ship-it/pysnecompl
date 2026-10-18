import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, Clock3, PackagePlus, Pause, Play, Send, ShoppingBag, TicketCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Marker = { id: number; title: string; category: string | null; lat: number; lng: number };
type Offer = { id: number; markerId: number; title: string; category: string | null; priceCents: number; quantityTotal: number; quantityAvailable: number; pickupDetails: string; pickupUntil: string | null; status: "active" | "paused" };
type Reservation = { id: number; offerId: number; status: string; paymentStatus?: string; priceCents: number; grossAmountCents?: number; platformFeeCents?: number; creatorNetCents?: number; responseDeadline: string; pickupExpiresAt: string | null; requestedAt: string; offerTitle: string };
type Request = { id: number; category: string | null; description: string; budgetCents: number | null; radiusKm: number; lat: number; lng: number; neededBy: string | null; createdAt: string };
type Analytics = { id: number; title: string; views: number; requests: number; accepted: number; rejected: number; picked_up: number; quantityAvailable: number; quantityTotal: number };
type ConnectStatus = { configured: boolean; onboardingStatus?: string; chargesEnabled: boolean; payoutsEnabled: boolean };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init, credentials: "same-origin",
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? "Nie udało się wykonać tej czynności.");
  return data as T;
}

const money = (cents: number) => `${(cents / 100).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const datetime = (value: string | null) => value ? new Date(value).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" }) : "Bez terminu";

export default function MarketplaceManageScreen({ creatorName }: { creatorName: string }) {
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [analytics, setAnalytics] = useState<Analytics[]>([]);
  const [connect, setConnect] = useState<ConnectStatus | null>(null);
  const [markerId, setMarkerId] = useState("");
  const [pricePln, setPricePln] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [pickupDetails, setPickupDetails] = useState("");
  const [pickupUntil, setPickupUntil] = useState("");
  const [pickupCodes, setPickupCodes] = useState<Record<number, string>>({});
  const [proposalOffers, setProposalOffers] = useState<Record<number, string>>({});
  const [proposalMessages, setProposalMessages] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [markerRows, offerRows, reservationRows, requestRows, analyticsRows] = await Promise.all([
        api<Marker[]>("/api/marketplace/creator-context"),
        api<Offer[]>("/api/marketplace/mine/offers"),
        api<Reservation[]>("/api/marketplace/mine/reservations"),
        api<Request[]>("/api/marketplace/mine/requests"),
        api<Analytics[]>("/api/marketplace/analytics"),
      ]);
      setMarkers(markerRows); setOffers(offerRows); setReservations(reservationRows); setRequests(requestRows); setAnalytics(analyticsRows);
      setConnect(await api<ConnectStatus>("/api/marketplace/connect/status"));
      setMarkerId((current) => current || String(markerRows[0]?.id ?? ""));
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się pobrać panelu ofert."); }
  }, []);

  const startConnectOnboarding = async () => {
    setError(null); setNotice(null);
    try {
      const result = await api<{ url: string }>("/api/marketplace/connect/onboarding", { method: "POST", body: JSON.stringify({}) });
      window.location.href = result.url;
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się rozpocząć konfiguracji wypłat."); }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const saveOffer = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null); setNotice(null);
    try {
      await api("/api/marketplace/offers", {
        method: "POST",
        body: JSON.stringify({ markerId: Number(markerId), pricePln, quantity: Number(quantity), pickupDetails, pickupUntil: pickupUntil ? new Date(pickupUntil).toISOString() : null }),
      });
      setNotice("Oferta została zapisana i jest widoczna w lokalnym wyszukiwaniu.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się zapisać oferty."); }
    finally { setBusy(false); }
  };

  const setOfferStatus = async (offer: Offer) => {
    setError(null); setNotice(null);
    try {
      await api(`/api/marketplace/offers/${offer.id}/status`, { method: "PATCH", body: JSON.stringify({ status: offer.status === "active" ? "paused" : "active" }) });
      setNotice(offer.status === "active" ? "Oferta została wstrzymana." : "Oferta jest ponownie aktywna.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się zmienić statusu oferty."); }
  };

  const respond = async (reservation: Reservation, action: "accept" | "reject") => {
    setError(null); setNotice(null);
    try {
      await api(`/api/marketplace/reservations/${reservation.id}/respond`, { method: "POST", body: JSON.stringify({ action }) });
      setNotice(action === "accept" ? "Rezerwacja przyjęta. Odbiorca zobaczy status w tej przeglądarce." : "Rezerwacja odrzucona, a sztuka wróciła do dostępnych.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się obsłużyć rezerwacji."); }
  };

  const confirmPickup = async (reservation: Reservation) => {
    setError(null); setNotice(null);
    try {
      await api(`/api/marketplace/reservations/${reservation.id}/pickup`, { method: "POST", body: JSON.stringify({ code: pickupCodes[reservation.id] ?? "" }) });
      setPickupCodes((current) => ({ ...current, [reservation.id]: "" }));
      setNotice("Odbiór potwierdzony. Kod został zużyty i nie zadziała ponownie.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się potwierdzić odbioru."); }
  };

  const propose = async (request: Request) => {
    setError(null); setNotice(null);
    try {
      await api(`/api/marketplace/requests/${request.id}/proposals`, { method: "POST", body: JSON.stringify({ offerId: Number(proposalOffers[request.id]), message: proposalMessages[request.id] ?? "" }) });
      setNotice("Propozycja została wysłana Odbiorcy.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Nie udało się wysłać propozycji."); }
  };

  return (
    <main className="min-h-screen bg-slate-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="flex items-center justify-between border-b bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900 sm:px-8"><a href="/" className="font-bold text-green-900 dark:text-green-300">Pysne.com.pl</a><span className="text-sm text-gray-600 dark:text-gray-300">Kreator: {creatorName}</span></header>
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-700 dark:text-amber-400">Panel Kreatora</p><h1 className="text-2xl font-bold sm:text-3xl">Oferty i rezerwacje</h1></div><Button variant="outline" asChild><a href="/panel"><ArrowLeft className="mr-2 h-4 w-4" />Wróć do mapy pinezek</a></Button></div>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">{error}</p>}
        {notice && <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">{notice}</p>}

        <section className="rounded-2xl border bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Wypłaty za transakcje</h2><p className="text-sm text-gray-600 dark:text-gray-300">Stripe Connect przechowuje płatność do czasu potwierdzenia odbioru.</p></div>{connect?.chargesEnabled && connect.payoutsEnabled ? <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-800">Wypłaty aktywne</span> : <Button onClick={() => void startConnectOnboarding()}>{connect?.configured ? "Dokończ konfigurację Stripe" : "Skonfiguruj wypłaty Stripe"}</Button>}</div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <form onSubmit={saveOffer} className="space-y-4 rounded-2xl border bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
            <div className="flex items-center gap-2"><PackagePlus className="h-5 w-5 text-green-700" /><h2 className="text-lg font-semibold">Opublikuj ofertę pinezki</h2></div>
            <p className="text-sm text-gray-600 dark:text-gray-300">Oferta korzysta z lokalizacji istniejącej pinezki. Token do gry pozostaje niezależny.</p>
            <label className="block space-y-1 text-sm font-medium">Pinezka<select required className="h-10 w-full rounded-md border bg-background px-3" value={markerId} onChange={(event) => setMarkerId(event.target.value)}><option value="">Wybierz pinezkę</option>{markers.map((marker) => <option key={marker.id} value={marker.id}>{marker.title}</option>)}</select></label>
            {markers.length === 0 && <p className="text-sm text-amber-700">Najpierw dodaj pinezkę na mapie.</p>}
            <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm font-medium">Cena (zł)<Input type="number" min="0" max="1000000" step="0.01" required value={pricePln} onChange={(event) => setPricePln(event.target.value)} placeholder="0 oznacza ofertę bezpłatną" /></label><label className="space-y-1 text-sm font-medium">Liczba sztuk<Input type="number" min="1" max="1000" step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label></div>
            <label className="block space-y-1 text-sm font-medium">Miejsce i instrukcja odbioru<Textarea required minLength={5} maxLength={1000} value={pickupDetails} onChange={(event) => setPickupDetails(event.target.value)} placeholder="Np. odbiór przy wejściu, po wcześniejszym uzgodnieniu" /></label>
            <label className="block space-y-1 text-sm font-medium">Oferta dostępna do (opcjonalnie)<Input type="datetime-local" value={pickupUntil} onChange={(event) => setPickupUntil(event.target.value)} /></label>
            <Button type="submit" disabled={busy || !markerId}><ShoppingBag className="mr-2 h-4 w-4" />{busy ? "Zapisywanie…" : "Zapisz ofertę"}</Button>
          </form>

          <section className="space-y-3 rounded-2xl border bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
            <h2 className="text-lg font-semibold">Twoje oferty</h2>
            {offers.length === 0 ? <p className="text-sm text-gray-600 dark:text-gray-300">Nie ma jeszcze opublikowanych ofert.</p> : offers.map((offer) => <article key={offer.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 dark:border-gray-700"><div><h3 className="font-semibold">{offer.title}</h3><p className="text-sm text-gray-600 dark:text-gray-300">{money(offer.priceCents)} · dostępne {offer.quantityAvailable} z {offer.quantityTotal} · {offer.status === "active" ? "aktywna" : "wstrzymana"}</p><p className="text-xs text-gray-500">{offer.pickupDetails}</p></div><Button variant="outline" size="sm" onClick={() => void setOfferStatus(offer)}>{offer.status === "active" ? <><Pause className="mr-2 h-4 w-4" />Wstrzymaj</> : <><Play className="mr-2 h-4 w-4" />Wznów</>}</Button></article>)}
          </section>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-3 rounded-2xl border bg-white p-5 dark:border-gray-800 dark:bg-gray-900"><div className="flex items-center gap-2"><Clock3 className="h-5 w-5 text-amber-700" /><h2 className="text-lg font-semibold">Zgłoszenia rezerwacji</h2></div><p className="text-xs text-gray-500">Lista odświeża się co 30 sekund. Odpowiedz w ciągu 24 godzin; po terminie sztuka wraca do oferty.</p>
            {reservations.length === 0 ? <p className="text-sm text-gray-600 dark:text-gray-300">Brak rezerwacji.</p> : reservations.map((reservation) => <article key={reservation.id} className="space-y-2 rounded-xl border p-3 dark:border-gray-700"><div className="flex items-center justify-between gap-2"><strong>{reservation.offerTitle} · {money(reservation.priceCents)}</strong><span className="text-xs font-semibold">{reservation.status}</span></div><p className="text-xs text-gray-500">Zgłoszono: {datetime(reservation.requestedAt)} · Odpowiedź do: {datetime(reservation.responseDeadline)}</p>{reservation.priceCents > 0 && <p className="text-xs text-gray-500">Kwota brutto {money(reservation.grossAmountCents ?? reservation.priceCents)} · opłata platformy {money(reservation.platformFeeCents ?? 0)} · dla Kreatora {money(reservation.creatorNetCents ?? 0)}</p>}
              {reservation.status === "requested" && <div className="flex gap-2"><Button size="sm" onClick={() => void respond(reservation, "accept")}><Check className="mr-2 h-4 w-4" />Przyjmij</Button><Button size="sm" variant="outline" onClick={() => void respond(reservation, "reject")}><X className="mr-2 h-4 w-4" />Odrzuć</Button></div>}
              {reservation.status === "pickup_ready" && <div className="flex flex-col gap-2 sm:flex-row"><Input aria-label={`Kod odbioru rezerwacji ${reservation.id}`} inputMode="numeric" maxLength={8} value={pickupCodes[reservation.id] ?? ""} onChange={(event) => setPickupCodes((current) => ({ ...current, [reservation.id]: event.target.value.replace(/\D/g, "").slice(0, 8) }))} placeholder="8-cyfrowy kod Odbiorcy" /><Button type="button" size="sm" disabled={(pickupCodes[reservation.id] ?? "").length !== 8} onClick={() => void confirmPickup(reservation)}><TicketCheck className="mr-2 h-4 w-4" />Potwierdź odbiór</Button></div>}
            </article>)}
          </div>

          <div className="space-y-3 rounded-2xl border bg-white p-5 dark:border-gray-800 dark:bg-gray-900"><div className="flex items-center gap-2"><Send className="h-5 w-5 text-blue-700" /><h2 className="text-lg font-semibold">„Szukam skarbu”</h2></div><p className="text-xs text-gray-500">Widoczne są zapytania dopasowane do lokalizacji, promienia, kategorii i budżetu Twojej oferty.</p>
            {requests.length === 0 ? <p className="text-sm text-gray-600 dark:text-gray-300">Nie znaleziono dopasowanych zapytań.</p> : requests.map((request) => <article key={request.id} className="space-y-3 rounded-xl border p-3 dark:border-gray-700"><p className="text-sm">{request.description}</p><p className="text-xs text-gray-500">{request.category || "Dowolna kategoria"} · do {request.radiusKm} km{request.budgetCents != null ? ` · budżet ${money(request.budgetCents)}` : ""}</p><div className="grid gap-2 sm:grid-cols-2"><select aria-label="Oferta do zaproponowania" className="h-10 rounded-md border bg-background px-3" value={proposalOffers[request.id] ?? ""} onChange={(event) => setProposalOffers((current) => ({ ...current, [request.id]: event.target.value }))}><option value="">Wybierz swoją ofertę</option>{offers.filter((offer) => offer.status === "active").map((offer) => <option key={offer.id} value={offer.id}>{offer.title} · {money(offer.priceCents)}</option>)}</select><Input aria-label="Wiadomość do Odbiorcy" maxLength={500} minLength={5} value={proposalMessages[request.id] ?? ""} onChange={(event) => setProposalMessages((current) => ({ ...current, [request.id]: event.target.value }))} placeholder="Krótka wiadomość" /></div><Button size="sm" disabled={!proposalOffers[request.id] || (proposalMessages[request.id] ?? "").trim().length < 5} onClick={() => void propose(request)}><Send className="mr-2 h-4 w-4" />Wyślij propozycję</Button></article>)}
          </div>
        </section>

        <section className="space-y-3 rounded-2xl border bg-white p-5 dark:border-gray-800 dark:bg-gray-900"><h2 className="text-lg font-semibold">Wyniki ofert</h2><p className="text-sm text-gray-600 dark:text-gray-300">Wyświetlenie liczy unikalną przeglądarkę raz dziennie. Liczniki zbierają zdarzenia od chwili uruchomienia funkcji; nie ma historycznych odsłon.</p><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{analytics.map((row) => <article key={row.id} className="rounded-xl border p-3 dark:border-gray-700"><h3 className="font-semibold">{row.title}</h3><p className="mt-2 text-sm">Wyświetlenia dzienne: <strong>{row.views}</strong></p><p className="text-sm">Rezerwacje: {row.requests} · przyjęte: {row.accepted}</p><p className="text-sm">Odrzucone: {row.rejected} · odebrane: {row.picked_up}</p><p className="text-xs text-gray-500">Dostępne: {row.quantityAvailable}/{row.quantityTotal}</p></article>)}</div>{analytics.length === 0 && <p className="text-sm text-gray-600 dark:text-gray-300">Statystyki pojawią się po opublikowaniu i wyświetleniu oferty.</p>}</section>

        <p className="text-xs text-gray-500">Pakiety pinezek nadal są sprzedawane osobno. Transakcje ofert są rozliczane przez Stripe Connect po potwierdzeniu odbioru.</p>
      </div>
    </main>
  );
}

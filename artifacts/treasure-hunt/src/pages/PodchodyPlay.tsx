import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readResponseError } from "@/lib/api-error";
import { openNavigation, safePopupImageUrl } from "@/pages/map-shared";
import { formatDuration, type GameSession } from "@/pages/podchody-types";
import { LogOut, Moon, Sun, ThumbsDown, ThumbsUp } from "lucide-react";

export default function PodchodyPlay({
  session,
  theme,
  onToggleTheme,
  onSession,
  onLeave,
}: {
  session: GameSession;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onSession: (session: GameSession) => void;
  onLeave: () => void;
}) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ratingBusy, setRatingBusy] = useState(false);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const map = L.map(mapContainer.current).setView([53.4285, 14.5528], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const area = session.current?.area;
    if (!map) return;
    circleRef.current?.remove();
    circleRef.current = null;
    if (!area) return;
    const circle = L.circle([area.lat, area.lng], {
      radius: area.radiusMeters,
      color: "#166534",
      fillColor: "#22c55e",
      fillOpacity: 0.28,
    }).addTo(map);
    circleRef.current = circle;
    map.fitBounds(circle.getBounds(), { padding: [28, 28] });
  }, [session.current?.position, session.current?.area.lat, session.current?.area.lng, session.finished]);

  const submitAnswer = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/games/session/attempt", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ gameId: session.gameId, answer }),
      });
      if (!response.ok) {
        setError(await readResponseError(response, "Nie udało się sprawdzić kodu."));
        return;
      }
      setAnswer("");
      onSession(await response.json());
    } catch {
      setError("Nie udało się sprawdzić kodu.");
    } finally {
      setBusy(false);
    }
  };

  const rate = async (value: 1 | -1) => {
    setRatingBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/games/session/rating", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ gameId: session.gameId, value }),
      });
      if (!response.ok) {
        setError(await readResponseError(response, "Nie udało się zapisać oceny."));
        return;
      }
      onSession(await response.json());
    } catch {
      setError("Nie udało się zapisać oceny.");
    } finally {
      setRatingBusy(false);
    }
  };

  const imageUrl = safePopupImageUrl(session.current?.imageUrl ?? null);

  return (
    <div className="flex min-h-[100dvh] flex-col bg-stone-50 dark:bg-gray-950 md:flex-row">
      <div className="relative h-[42dvh] md:h-auto md:min-h-[100dvh] md:w-1/2">
        <div ref={mapContainer} className="absolute inset-0" />
      </div>
      <section className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 md:w-1/2 md:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-700">Podchody</p>
            <h1 className="text-2xl font-bold text-green-950 dark:text-green-300">{session.title}</h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{session.description}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onToggleTheme} aria-label={theme === "dark" ? "Tryb jasny" : "Tryb ciemny"} className="flex h-10 w-10 items-center justify-center rounded-xl border bg-white dark:bg-gray-800">
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button type="button" onClick={onLeave} aria-label="Wyjdź z gry" className="flex h-10 w-10 items-center justify-center rounded-xl border bg-white dark:bg-gray-800">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
        <p className="text-sm text-gray-700 dark:text-gray-200">
          Grasz jako <strong>{session.nickname}</strong>{session.teamName ? ` · zespół ${session.teamName}` : ""}. Organizator: {session.organizerName} ({session.organizerScore > 0 ? `+${session.organizerScore}` : session.organizerScore}).
        </p>
        {session.finished ? (
          <div className="rounded-2xl bg-green-800 p-4 text-white">
            <h2 className="text-xl font-bold">Gra ukończona</h2>
            <p className="mt-1 text-sm">Czas: {formatDuration(session.durationMs)}. Punkty: {session.solvedCount}/{session.total}.</p>
            {session.myRating == null ? (
              <div className="mt-3">
                <p className="text-sm">Oceń organizatora. Jedna ocena na grę.</p>
                <div className="mt-2 flex gap-2">
                  <Button type="button" disabled={ratingBusy} onClick={() => void rate(1)} className="bg-white text-green-900 hover:bg-green-50"><ThumbsUp className="mr-1 h-4 w-4" />Tak</Button>
                  <Button type="button" disabled={ratingBusy} onClick={() => void rate(-1)} variant="outline" className="border-white bg-transparent text-white hover:bg-green-700"><ThumbsDown className="mr-1 h-4 w-4" />Nie</Button>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm">Dziękujemy za ocenę organizatora.</p>
            )}
          </div>
        ) : session.current && (
          <div className="rounded-2xl border border-green-200 bg-white p-4 dark:border-green-900 dark:bg-gray-900">
            <p className="text-xs font-bold uppercase tracking-wider text-green-800 dark:text-green-300">Punkt {session.current.position} z {session.total}</p>
            {imageUrl && <img src={imageUrl} alt="" className="mt-3 h-36 w-full rounded-lg object-cover" />}
            <p className="mt-3 text-base text-gray-800 dark:text-gray-100">{session.current.hint}</p>
            <p className="mt-2 text-xs text-gray-500">Na mapie widać przybliżony obszar, nie dokładne miejsce. Kod jest przy punkcie.</p>
            <Button type="button" className="mt-3 w-full bg-blue-600 hover:bg-blue-700" onClick={() => openNavigation(session.current!.area.lat, session.current!.area.lng)}>Nawiguj</Button>
            <form onSubmit={submitAnswer} className="mt-3 space-y-2">
              <Input value={answer} onChange={(event) => setAnswer(event.target.value.toUpperCase())} maxLength={12} autoComplete="off" placeholder="Kod z punktu" aria-label="Kod punktu" className="uppercase tracking-widest" />
              <Button type="submit" disabled={busy || answer.trim().length < 3} className="w-full bg-amber-500 hover:bg-amber-600">{busy ? "Sprawdzanie…" : "Sprawdź kod"}</Button>
            </form>
          </div>
        )}
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-200">{error}</p>}
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-700 dark:text-gray-200">Ranking</h2>
          <ol className="mt-2 space-y-1">
            {session.ranking.map((row) => (
              <li key={`${row.place}-${row.nickname}`} className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-sm dark:bg-gray-900">
                <span><strong>{row.place}.</strong> {row.nickname}{row.teamName ? ` · ${row.teamName}` : ""}</span>
                <span className="text-xs text-gray-500">{row.finished ? formatDuration(row.durationMs) : `${row.solvedCount}/${session.total}`}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}

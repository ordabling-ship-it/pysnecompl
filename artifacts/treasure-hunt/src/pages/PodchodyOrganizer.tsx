import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { readResponseError } from "@/lib/api-error";
import { copyToClipboard, processImageFile } from "@/pages/map-shared";
import type { OrganizerGame } from "@/pages/podchody-types";
import { Copy, MapPin, Plus, Trash2 } from "lucide-react";

type DraftCheckpoint = { hint: string; answerCode: string; lat: string; lng: string; imageUrl: string | null };
type PickedPoint = { index: number; lat: number; lng: number; nonce: number };

const emptyCheckpoint = (): DraftCheckpoint => ({ hint: "", answerCode: "", lat: "", lng: "", imageUrl: null });

export default function PodchodyOrganizer({
  layoutPreview = false,
  hasUnlimitedPins,
  picked,
  onRequestPick,
  onNeedPins,
  onPublished,
}: {
  layoutPreview?: boolean;
  hasUnlimitedPins: boolean;
  picked: PickedPoint | null;
  onRequestPick: (index: number) => void;
  onNeedPins: () => void;
  onPublished: (pinBalance: number, charged: boolean) => void;
}) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [checkpoints, setCheckpoints] = useState<DraftCheckpoint[]>([emptyCheckpoint(), emptyCheckpoint()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [games, setGames] = useState<OrganizerGame[]>([]);

  const loadGames = async () => {
    if (layoutPreview) return;
    const response = await fetch("/api/games", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (response.ok) setGames(await response.json());
  };

  useEffect(() => { void loadGames(); }, [layoutPreview]);

  useEffect(() => {
    if (!picked) return;
    setCheckpoints((current) => current.map((checkpoint, index) => index === picked.index
      ? { ...checkpoint, lat: picked.lat.toFixed(6), lng: picked.lng.toFixed(6) }
      : checkpoint));
  }, [picked]);

  const updateCheckpoint = (index: number, patch: Partial<DraftCheckpoint>) => {
    setCheckpoints((current) => current.map((checkpoint, itemIndex) => itemIndex === index ? { ...checkpoint, ...patch } : checkpoint));
  };

  const publish = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/games", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          title,
          description,
          checkpoints: checkpoints.map((checkpoint) => ({
            hint: checkpoint.hint,
            answerCode: checkpoint.answerCode,
            lat: Number(checkpoint.lat),
            lng: Number(checkpoint.lng),
            imageUrl: checkpoint.imageUrl,
          })),
        }),
      });
      if (response.status === 402) {
        onNeedPins();
        setError(await readResponseError(response, "Brak pinezek."));
        return;
      }
      if (!response.ok) {
        setError(await readResponseError(response, "Nie udało się opublikować gry."));
        return;
      }
      const created = await response.json() as OrganizerGame & { charged: boolean; pinBalance: number };
      onPublished(created.pinBalance, created.charged);
      setTitle("");
      setDescription("");
      setCheckpoints([emptyCheckpoint(), emptyCheckpoint()]);
      await loadGames();
      const copied = await copyToClipboard(created.joinCode);
      toast({ title: "Gra opublikowana", description: copied ? `Kod ${created.joinCode} jest w schowku.` : `Kod gry: ${created.joinCode}` });
    } catch {
      setError("Nie udało się opublikować gry.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <form onSubmit={publish} className="space-y-3 rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-green-800 dark:text-green-300">Nowa gra</div>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">Ułóż 2–10 punktów. Publikacja kosztuje {hasUnlimitedPins ? "0 pinezek na tym koncie" : "1 pinezkę"}.</p>
        </div>
        <Input required minLength={3} maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Tytuł gry" aria-label="Tytuł gry" />
        <Textarea required maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Krótki opis dla uczestników" aria-label="Opis gry" className="min-h-16 resize-none" />
        {checkpoints.map((checkpoint, index) => (
          <div key={index} className="space-y-2 rounded-lg border border-green-100 p-2 dark:border-green-900">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span>Punkt {index + 1}</span>
              {checkpoints.length > 2 && (
                <button type="button" aria-label={`Usuń punkt ${index + 1}`} onClick={() => setCheckpoints((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="text-red-600">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Textarea required maxLength={500} value={checkpoint.hint} onChange={(event) => updateCheckpoint(index, { hint: event.target.value })} placeholder="Zagadka albo wskazówka" aria-label={`Wskazówka punktu ${index + 1}`} className="min-h-16 resize-none" />
            <Input required minLength={3} maxLength={12} value={checkpoint.answerCode} onChange={(event) => updateCheckpoint(index, { answerCode: event.target.value.toUpperCase() })} placeholder="Kod przy punkcie" aria-label={`Kod punktu ${index + 1}`} className="uppercase" />
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => onRequestPick(index)}>
                <MapPin className="mr-1 h-3.5 w-3.5" />
                Wskaż na mapie
              </Button>
              <span className="text-[11px] text-gray-500">{checkpoint.lat && checkpoint.lng ? `${checkpoint.lat}, ${checkpoint.lng}` : "Brak miejsca"}</span>
            </div>
            <input aria-label={`Zdjęcie punktu ${index + 1}`} type="file" accept="image/*" className="block w-full text-xs" onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              try {
                updateCheckpoint(index, { imageUrl: await processImageFile(file) });
              } catch {
                toast({ variant: "destructive", title: "Błąd zdjęcia", description: "Nie można przetworzyć obrazu." });
              }
            }} />
          </div>
        ))}
        {checkpoints.length < 10 && (
          <Button type="button" variant="outline" className="w-full" onClick={() => setCheckpoints((current) => [...current, emptyCheckpoint()])}>
            <Plus className="mr-1 h-4 w-4" />
            Dodaj punkt
          </Button>
        )}
        {error && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{error}</p>}
        <Button type="submit" disabled={busy || layoutPreview} className="w-full bg-green-700 hover:bg-green-800">
          {busy ? "Publikowanie…" : hasUnlimitedPins ? "Opublikuj grę" : "Opublikuj grę (1 pinezka)"}
        </Button>
      </form>
      <div className="space-y-2">
        {games.map((game) => (
          <div key={game.id} className="rounded-lg border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-800">
            <div className="font-semibold text-green-900 dark:text-green-300">{game.title}</div>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs">
              <code className="rounded bg-amber-100 px-2 py-0.5 font-bold tracking-widest text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{game.joinCode}</code>
              <button type="button" aria-label="Kopiuj kod gry" onClick={async () => { const ok = await copyToClipboard(game.joinCode); toast({ title: ok ? "Kod skopiowany" : "Nie udało się skopiować" }); }}>
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 text-[11px] text-gray-600 dark:text-gray-300">
              {game.checkpointCount} punktów · {game.playerCount} graczy · ukończyło {game.finishedCount}
              <span className="mt-1 block font-semibold">Ocena organizatora: {game.organizerScore > 0 ? `+${game.organizerScore}` : game.organizerScore}</span>
            </div>
          </div>
        ))}
        {games.length === 0 && <p className="text-center text-xs text-gray-500">Nie masz jeszcze opublikowanej gry.</p>}
      </div>
    </div>
  );
}

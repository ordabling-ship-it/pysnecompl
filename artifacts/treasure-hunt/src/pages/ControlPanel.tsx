import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { copyToClipboard } from "@/pages/map-shared";

type ManagedUser = {
  id: number;
  name: string;
  slug: string;
  role: string;
  parentUserId: number | null;
  pinBalance: number;
  totalPins: number;
  discoveries: number;
  redemptions: number;
};

type Overview = {
  accounts: number;
  admins: number;
  moderators: number;
  markers: number;
  activatedMarkers: number;
  activeMarkers: number;
  expiredMarkers: number;
  totalRedemptions: number;
  creatorUsage: Array<{ id: number; name: string; slug: string; pinBalance: number; markers: number; activations: number; activeMarkers: number; redemptions: number }>;
};

type ActivityEvent = {
  id: number;
  eventType: string;
  createdAt: string;
  actorName: string | null;
  details: Record<string, string | number | boolean | null>;
};

const EVENT_LABELS: Record<string, string> = {
  account_created: "Utworzono konto",
  account_password_reset: "Zmieniono hasło konta",
  marker_created: "Dodano skarb",
  treasure_activated: "Gość rozpoczął grę",
  code_redeemed: "Odblokowano kod",
  admin_login: "Logowanie administratora",
  game_published: "Opublikowano grę Podchody",
  game_rated: "Oceniono organizatora",
};

export default function ControlPanel({ user }: { user: { role: string } }) {
  const { toast } = useToast();
  const [managedUsers, setManagedUsers] = useState<ManagedUser[]>([]);
  const [globalOverview, setGlobalOverview] = useState<Overview | null>(null);
  const [managedActivity, setManagedActivity] = useState<ActivityEvent[]>([]);
  const [accountName, setAccountName] = useState("");
  const [accountRole, setAccountRole] = useState("admin");
  const [createdInviteUrl, setCreatedInviteUrl] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [inviteBusyId, setInviteBusyId] = useState<number | null>(null);
  const [passwordResetTargetId, setPasswordResetTargetId] = useState<number | null>(null);
  const [passwordResetValue, setPasswordResetValue] = useState("");
  const [passwordResetConfirm, setPasswordResetConfirm] = useState("");
  const [passwordResetError, setPasswordResetError] = useState<string | null>(null);
  const [passwordResetBusy, setPasswordResetBusy] = useState(false);

  const loadManagedUsers = async () => {
    const response = await fetch("/api/control/users", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (response.ok) setManagedUsers(await response.json());
    const overviewResponse = await fetch("/api/control/overview", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (overviewResponse.ok) setGlobalOverview(await overviewResponse.json());
    const activityResponse = await fetch("/api/control/activity", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (activityResponse.ok) setManagedActivity(await activityResponse.json());
  };

  useEffect(() => {
    void loadManagedUsers();
  }, []);

  const handleCreateManagedAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    setAccountError(null);
    setAccountBusy(true);
    try {
      const response = await fetch("/api/control/users", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username: accountName, role: accountRole }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Nie udało się utworzyć konta.");
      setAccountName("");
      setCreatedInviteUrl(result.inviteUrl ?? null);
      await loadManagedUsers();
      toast({ title: "Konto utworzone", description: `Zaproszenie dla ${result.name} ważne do ${new Date(result.inviteExpiresAt).toLocaleString("pl-PL")}.` });
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Nie udało się utworzyć konta.");
    } finally {
      setAccountBusy(false);
    }
  };

  const handleReissueInvite = async (targetId: number, targetName: string) => {
    setInviteBusyId(targetId);
    try {
      const response = await fetch(`/api/control/users/${targetId}/invite`, { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Nie udało się utworzyć zaproszenia.");
      setCreatedInviteUrl(result.inviteUrl);
      toast({ title: "Nowe zaproszenie gotowe", description: `Link dla ${targetName} zastąpił poprzedni link.` });
    } catch (error) {
      toast({ variant: "destructive", title: "Błąd zaproszenia", description: error instanceof Error ? error.message : "Spróbuj ponownie." });
    } finally {
      setInviteBusyId(null);
    }
  };

  const handleResetManagedPassword = async (event: React.FormEvent, targetId: number, targetName: string) => {
    event.preventDefault();
    setPasswordResetError(null);
    if (passwordResetValue !== passwordResetConfirm) {
      setPasswordResetError("Hasła nie są takie same.");
      return;
    }
    setPasswordResetBusy(true);
    try {
      const response = await fetch(`/api/control/users/${targetId}/password`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ password: passwordResetValue }),
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error ?? "Nie udało się zmienić hasła.");
      }
      setPasswordResetTargetId(null);
      setPasswordResetValue("");
      setPasswordResetConfirm("");
      await loadManagedUsers();
      toast({ title: "Hasło zmienione", description: `Nowe hasło dla ${targetName} zostało zapisane.` });
    } catch (error) {
      setPasswordResetError(error instanceof Error ? error.message : "Nie udało się zmienić hasła.");
    } finally {
      setPasswordResetBusy(false);
    }
  };

  return (
    <details className="rounded-xl border border-green-200 bg-white p-3 dark:border-green-900 dark:bg-gray-800">
      <summary className="cursor-pointer font-semibold text-green-950 dark:text-green-100">
        {user.role === "master_admin" ? "Panel główny · konta i statystyki" : "Konta kreatorów"}
      </summary>
      <form onSubmit={handleCreateManagedAccount} className="mt-3 space-y-2">
        <label className="block text-xs font-medium">Login
          <Input required minLength={3} maxLength={32} value={accountName} onChange={(event) => setAccountName(event.target.value)} className="mt-1 h-9" autoComplete="off" />
        </label>
        {user.role === "master_admin" && (
          <label className="block text-xs font-medium">Rola
            <select value={accountRole} onChange={(event) => setAccountRole(event.target.value)} className="mt-1 h-9 w-full rounded-md border bg-white px-2 dark:bg-gray-900">
              <option value="admin">Kreator</option>
              <option value="moderator">Moderator</option>
            </select>
          </label>
        )}
        {accountError && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{accountError}</p>}
        <Button type="submit" disabled={accountBusy} className="w-full bg-green-700 hover:bg-green-800">
          {accountBusy ? "Tworzenie…" : `Utwórz ${accountRole === "admin" ? "Kreatora" : "Moderatora"}`}
        </Button>
      </form>
      {createdInviteUrl && (
        <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
          <strong>Przekaż to zaproszenie nowemu użytkownikowi.</strong>
          <p className="mt-1">Link działa 48 godzin i pozwala samodzielnie ustawić hasło.</p>
          <a href={createdInviteUrl} className="mt-2 block break-all underline" target="_blank" rel="noreferrer">{createdInviteUrl}</a>
          <Button type="button" variant="outline" size="sm" className="mt-2 h-8" onClick={async () => { const ok = await copyToClipboard(createdInviteUrl); toast({ title: ok ? "Link skopiowany" : "Nie udało się skopiować linku" }); }}>Kopiuj zaproszenie</Button>
        </div>
      )}
      {globalOverview && (
        <div className="mt-3 rounded-lg bg-green-50 p-2 text-xs dark:bg-green-950/40">
          <div className="grid grid-cols-2 gap-2">
            <div><strong>{globalOverview.accounts}</strong><span className="block text-gray-600 dark:text-gray-300">Konta w serwisie</span></div>
            <div><strong>{globalOverview.admins}</strong><span className="block text-gray-600 dark:text-gray-300">Kreatorzy</span></div>
            <div><strong>{globalOverview.markers}</strong><span className="block text-gray-600 dark:text-gray-300">Utworzone skarby</span></div>
            <div><strong>{globalOverview.activatedMarkers}</strong><span className="block text-gray-600 dark:text-gray-300">Aktywacje gry</span></div>
            <div><strong>{globalOverview.activeMarkers}</strong><span className="block text-gray-600 dark:text-gray-300">Aktywne skarby</span></div>
            <div><strong>{globalOverview.totalRedemptions}</strong><span className="block text-gray-600 dark:text-gray-300">Odblokowania kodów</span></div>
          </div>
        </div>
      )}
      <div className="mt-4 space-y-2 border-t pt-3">
        {managedUsers.map((managed) => (
          <div key={managed.id} className="rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-gray-900">
            <div className="flex items-center justify-between gap-2 font-semibold">
              <span>{managed.name} <span className="font-normal text-gray-500">· {managed.role === "admin" ? "Kreator" : managed.role === "moderator" ? "Moderator" : managed.role}</span></span>
              <span>{managed.role === "master_admin" || managed.role === "moderator" ? "Bez limitu pinezek" : `${managed.pinBalance} pinezek`}</span>
            </div>
            <div className="mt-1 text-gray-600 dark:text-gray-300">{managed.totalPins} skarbów · {managed.discoveries} aktywacji · {managed.redemptions} odblokowań</div>
            {managed.role === "admin" && (
              <Button type="button" variant="outline" size="sm" className="mt-2 h-8 w-full" disabled={inviteBusyId === managed.id} onClick={() => void handleReissueInvite(managed.id, managed.name)}>
                {inviteBusyId === managed.id ? "Tworzenie linku…" : "Utwórz nowe zaproszenie"}
              </Button>
            )}
            {user.role === "master_admin" && managed.role !== "master_admin" && (
              passwordResetTargetId === managed.id ? (
                <form onSubmit={(event) => handleResetManagedPassword(event, managed.id, managed.name)} className="mt-2 space-y-2 rounded-md border border-green-200 p-2 dark:border-green-900">
                  <label className="block text-xs font-medium">Nowe hasło (min. 15 znaków)
                    <Input required minLength={15} maxLength={128} type="password" value={passwordResetValue} onChange={(event) => setPasswordResetValue(event.target.value)} className="mt-1 h-9" autoComplete="new-password" />
                  </label>
                  <label className="block text-xs font-medium">Powtórz nowe hasło
                    <Input required minLength={15} maxLength={128} type="password" value={passwordResetConfirm} onChange={(event) => setPasswordResetConfirm(event.target.value)} className="mt-1 h-9" autoComplete="new-password" />
                  </label>
                  {passwordResetError && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{passwordResetError}</p>}
                  <div className="flex gap-2">
                    <Button type="submit" disabled={passwordResetBusy} className="flex-1 bg-green-700 hover:bg-green-800">{passwordResetBusy ? "Zapisywanie…" : "Zapisz hasło"}</Button>
                    <Button type="button" variant="outline" disabled={passwordResetBusy} onClick={() => { setPasswordResetTargetId(null); setPasswordResetValue(""); setPasswordResetConfirm(""); setPasswordResetError(null); }}>Anuluj</Button>
                  </div>
                </form>
              ) : (
                <Button type="button" variant="outline" className="mt-2 w-full" onClick={() => { setPasswordResetTargetId(managed.id); setPasswordResetError(null); }}>Ustaw nowe hasło</Button>
              )
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 border-t pt-3">
        <div className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-600 dark:text-gray-300">Ostatnie zdarzenia serwisu</div>
        <div className="max-h-56 space-y-2 overflow-y-auto">
          {managedActivity.map((event) => (
            <div key={event.id} className="rounded-md bg-gray-50 px-2.5 py-2 text-[11px] dark:bg-gray-900">
              <div className="font-semibold">{EVENT_LABELS[event.eventType] ?? event.eventType}</div>
              <div className="text-gray-600 dark:text-gray-300">{event.actorName ?? "Gość"}{event.details.username ? ` · ${event.details.username}` : ""} · {new Date(event.createdAt).toLocaleString("pl-PL")}</div>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

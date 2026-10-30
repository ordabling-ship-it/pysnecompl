import { useState } from "react";
import { useAdminLogin, useGuestLogin } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Key, User, ArrowLeft, AlertCircle, Sun, Moon } from "lucide-react";
import type { GuestData } from "@/App";
import type { GameSession } from "@/pages/podchody-types";
import { readApiError, readResponseError } from "@/lib/api-error";

type AuthScreenProps = {
  onLoginAdmin: (user: { id: number; name: string; role: string; slug?: string; pinBalance?: number; canAccessAnalytics?: boolean }) => void;
  onLoginGuest: (guestData: GuestData) => void;
  onJoinGame?: (session: GameSession) => void;
  mode?: "player" | "panel" | "activate";
  activationToken?: string;
  theme: "light" | "dark";
  onToggleTheme: () => void;
};

export default function AuthScreen({ onLoginAdmin, onLoginGuest, onJoinGame, theme, onToggleTheme, mode = "player", activationToken = "" }: AuthScreenProps) {
  const [view, setView] = useState<"game" | "treasure" | "admin">(mode === "panel" ? "admin" : "game");
  const [code, setCode] = useState("");
  const [nickname, setNickname] = useState("");
  const [teamName, setTeamName] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinBusy, setJoinBusy] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [activationPassword, setActivationPassword] = useState("");
  const [activationConfirm, setActivationConfirm] = useState("");
  const [activationError, setActivationError] = useState<string | null>(null);
  const [activationBusy, setActivationBusy] = useState(false);
  const { toast } = useToast();

  const guestLogin = useGuestLogin();
  const adminLogin = useAdminLogin();

  const handleGuestSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code) return;
    guestLogin.mutate(
      { data: { code: code.toUpperCase() } },
      {
        onSuccess: (data) => {
          onLoginGuest(data);
          toast({ title: "Kod przyjęty", description: `Na mapie jest miejsce skarbu „${data.markerTitle}”. Teraz go znajdź.` });
        },
        onError: (error) => {
          toast({ variant: "destructive", title: "Błąd", description: readApiError(error, "Nieprawidłowy kod skarbu.") });
        },
      }
    );
  };

  const handleJoinSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setJoinError(null);
    setJoinBusy(true);
    try {
      const response = await fetch("/api/games/join", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ code: code.toUpperCase(), nickname, teamName: teamName.trim() || null }),
      });
      if (!response.ok) {
        setJoinError(await readResponseError(response, "Nie udało się dołączyć do gry."));
        return;
      }
      const session = await response.json() as GameSession;
      onJoinGame?.(session);
    } catch {
      setJoinError("Nie udało się dołączyć do gry.");
    } finally {
      setJoinBusy(false);
    }
  };

  const handleAdminSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;
    setLoginError(null);
    adminLogin.mutate(
      { data: { username, password } },
      {
        onSuccess: (data) => {
          onLoginAdmin(data);
        },
        onError: (error) => {
          setLoginError(readApiError(error, "Nieprawidłowa nazwa użytkownika lub hasło."));
        },
      }
    );
  };

  const handleActivationSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setActivationError(null);
    if (activationPassword !== activationConfirm) {
      setActivationError("Hasła nie są takie same.");
      return;
    }
    setActivationBusy(true);
    try {
      const response = await fetch("/api/auth/activate-account", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token: activationToken, password: activationPassword }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Nie udało się aktywować konta.");
      window.location.replace("/panel");
    } catch (error) {
      setActivationError(error instanceof Error ? error.message : "Nie udało się aktywować konta.");
      setActivationBusy(false);
    }
  };

  if (mode === "activate") {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-gradient-to-br from-green-900 to-amber-600 dark:from-gray-900 dark:to-gray-800 p-4">
        <Card className="w-full max-w-md shadow-2xl border-none bg-white dark:bg-gray-900 dark:border dark:border-gray-700 dark:text-gray-100">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl text-green-950 dark:text-green-300">Ustaw hasło do konta</CardTitle>
            <CardDescription>Link jest jednorazowy i ważny przez 48 godzin. Hasło musi mieć co najmniej 8 znaków.</CardDescription>
          </CardHeader>
          <form onSubmit={handleActivationSubmit}>
            <CardContent className="space-y-4">
              <Input aria-label="Nowe hasło" type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={activationPassword} onChange={(event) => setActivationPassword(event.target.value)} placeholder="Nowe hasło · min. 8 znaków" />
              <Input aria-label="Powtórz hasło" type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={activationConfirm} onChange={(event) => setActivationConfirm(event.target.value)} placeholder="Powtórz hasło" />
              {activationError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{activationError}</p>}
            </CardContent>
            <CardFooter className="flex-col gap-3">
              <Button type="submit" className="w-full bg-green-700 hover:bg-green-800" disabled={activationBusy || !activationToken}>{activationBusy ? "Aktywowanie…" : "Ustaw hasło i otwórz panel"}</Button>
              {!activationToken && <p className="text-sm text-red-700">Brak klucza zaproszenia w linku. Poproś opiekuna konta o nowy link.</p>}
            </CardFooter>
          </form>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-gradient-to-br from-green-900 to-amber-600 dark:from-gray-900 dark:to-gray-800 p-4 relative">

      {/* Theme toggle — floats on the gradient, not inside the card */}
      <button
        type="button"
        onClick={onToggleTheme}
        title={theme === "dark" ? "Tryb jasny" : "Tryb ciemny"}
        className="fixed top-4 right-4 z-10 w-9 h-9 flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 text-white backdrop-blur transition-colors"
      >
        {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </button>

      <Card className="w-full max-w-md shadow-2xl border-none bg-white dark:bg-gray-900 dark:border dark:border-gray-700 dark:text-gray-100">
        {view === "game" ? (
          <>
            <CardHeader className="space-y-2 text-center">
              <div className="mx-auto mb-4 flex h-24 w-24 items-center justify-center rounded-full bg-amber-100 shadow-lg ring-2 ring-amber-200 dark:bg-amber-900/40 dark:ring-amber-700">
                <img src="/logo.png" alt="Pysne.com.pl" className="h-16 w-16 select-none object-contain" draggable={false} />
              </div>
              <CardTitle className="text-3xl font-bold text-green-950 dark:text-green-300">Pysne.com.pl</CardTitle>
              <CardDescription className="text-lg text-green-800 dark:text-green-400">Dołącz do gry</CardDescription>
            </CardHeader>
            <form onSubmit={handleJoinSubmit}>
              <CardContent className="space-y-3">
                <Input aria-label="Kod gry" placeholder="KOD GRY" className="h-14 text-center text-2xl uppercase tracking-widest" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={5} disabled={joinBusy} />
                <Input aria-label="Nazwa gracza" placeholder="Twoja nazwa" value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={24} disabled={joinBusy} required />
                <Input aria-label="Nazwa zespołu" placeholder="Zespół (opcjonalnie)" value={teamName} onChange={(event) => setTeamName(event.target.value)} maxLength={32} disabled={joinBusy} />
                {joinError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{joinError}</p>}
              </CardContent>
              <CardFooter className="flex flex-col space-y-3">
                <Button type="submit" className="h-14 w-full bg-amber-500 text-lg text-white hover:bg-amber-600" disabled={joinBusy || code.trim().length !== 5 || nickname.trim().length < 2}>
                  {joinBusy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Key className="mr-2 h-5 w-5" />}
                  Dołącz do gry
                </Button>
                <button type="button" className="text-sm font-medium text-green-800 underline underline-offset-4 dark:text-green-300" onClick={() => { setView("treasure"); setJoinError(null); }}>Mam kod skarbu</button>
                <a href="/panel" className="text-sm font-medium text-green-800 underline underline-offset-4 dark:text-green-300">Jestem organizatorem</a>
              </CardFooter>
            </form>
          </>
        ) : view === "treasure" ? (
          <>
            <CardHeader className="text-center space-y-2">
              <div className="mx-auto w-24 h-24 bg-amber-100 dark:bg-amber-900/40 rounded-full flex items-center justify-center mb-4 shadow-lg ring-2 ring-amber-200 dark:ring-amber-700">
                <img
                  src="/logo.png"
                  alt="Pysne.com.pl"
                  className="w-16 h-16 object-contain select-none logo-themed"
                  draggable={false}
                />
              </div>
              <CardTitle className="text-3xl font-bold text-green-950 dark:text-green-300">Pysne.com.pl</CardTitle>
              <CardDescription className="text-green-800 dark:text-green-400 text-lg">Wpisz kod, aby odkryć skarb</CardDescription>
            </CardHeader>
            <form onSubmit={handleGuestSubmit}>
              <CardContent>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Input
                      id="code"
                      placeholder="KOD SKARBU"
                      className="text-center text-2xl uppercase tracking-widest h-14 border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus-visible:ring-amber-500"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      maxLength={5}
                      disabled={guestLogin.isPending}
                    />
                    <p className="px-1 text-center text-xs leading-relaxed text-green-800/80 dark:text-green-300/80">
                      Wpisz kod znaleziony przy skarbie, aby zobaczyć wskazówkę i miejsce na mapie.
                    </p>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="flex flex-col space-y-4">
                <Button
                  type="submit"
                  className="w-full h-14 text-lg bg-amber-500 hover:bg-amber-600 text-white shadow-lg"
                  disabled={guestLogin.isPending || !code}
                >
                  {guestLogin.isPending ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Key className="w-5 h-5 mr-2" />}
                  Pokaż miejsce
                </Button>
                <button type="button" className="text-sm font-medium text-green-800 underline underline-offset-4 dark:text-green-300" onClick={() => setView("game")}>Dołącz do gry</button>
                <a href="/panel" className="text-sm font-medium text-green-800 underline underline-offset-4 hover:text-green-950 dark:text-green-300 dark:hover:text-green-100">Jestem organizatorem</a>
              </CardFooter>
            </form>
          </>
        ) : (
          <>
            <CardHeader>
              <Button
                variant="ghost"
                size="icon"
                className="w-8 h-8 absolute top-4 left-4 text-green-800 dark:text-green-400 hover:text-green-900 dark:hover:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/40"
                onClick={() => { window.location.href = "/"; }}
              >
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <CardTitle className="text-2xl font-bold text-green-950 dark:text-green-300 text-center mt-2">Logowanie do panelu</CardTitle>
            </CardHeader>
            <form onSubmit={handleAdminSubmit}>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="username" className="text-gray-700 dark:text-gray-300 font-medium">Nazwa użytkownika</Label>
                  <Input
                    id="username"
                    value={username}
                    onChange={(e) => { setUsername(e.target.value); setLoginError(null); }}
                    disabled={adminLogin.isPending}
                    className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-green-300 dark:border-gray-600 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus-visible:ring-green-500"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password" className="text-gray-700 dark:text-gray-300 font-medium">Hasło</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setLoginError(null); }}
                    disabled={adminLogin.isPending}
                    className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-green-300 dark:border-gray-600 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus-visible:ring-green-500"
                  />
                </div>

                {/* Inline error message */}
                {loginError && (
                  <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {loginError}
                  </div>
                )}
              </CardContent>

              <CardFooter className="flex-col gap-3">
                <Button
                  type="submit"
                  className="w-full bg-green-700 hover:bg-green-800 dark:bg-green-800 dark:hover:bg-green-700 text-white"
                  disabled={adminLogin.isPending || !username || !password}
                >
                  {adminLogin.isPending ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <User className="w-5 h-5 mr-2" />}
                  Wejdź do panelu
                </Button>
              </CardFooter>
            </form>
          </>
        )}
      </Card>
    </div>
  );
}

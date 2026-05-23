import { useState } from "react";
import { useAdminLogin, useGuestLogin } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Key, User, ArrowLeft, Coins, AlertCircle, Sun, Moon } from "lucide-react";
import { getOrCreateGuestToken, type GuestData } from "@/App";

type AuthScreenProps = {
  onLoginAdmin: (user: { id: number; name: string; role: string }) => void;
  onLoginGuest: (guestData: GuestData) => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
};

export default function AuthScreen({ onLoginAdmin, onLoginGuest, theme, onToggleTheme }: AuthScreenProps) {
  const [view, setView] = useState<"guest" | "admin">("guest");
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const { toast } = useToast();

  const guestLogin = useGuestLogin();
  const adminLogin = useAdminLogin();

  const handleGuestSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code) return;
    const guestToken = getOrCreateGuestToken();
    guestLogin.mutate(
      { data: { code: code.toUpperCase(), guestToken } },
      {
        onSuccess: (data) => {
          onLoginGuest(data);
          toast({ title: "Skarb odkryty!", description: `Znalazłeś: ${data.markerTitle}` });
        },
        onError: () => {
          toast({ variant: "destructive", title: "Błąd", description: "Nieprawidłowy kod skarbu." });
        },
      }
    );
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
        onError: () => {
          setLoginError("Nieprawidłowa nazwa użytkownika lub hasło.");
        },
      }
    );
  };

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
        {view === "guest" ? (
          <>
            <CardHeader className="text-center space-y-2">
              <div className="mx-auto w-24 h-24 bg-amber-100 dark:bg-amber-900/40 rounded-full flex items-center justify-center mb-4 shadow-lg ring-2 ring-amber-200 dark:ring-amber-700">
                <img
                  src="/logo.png"
                  alt="Pysne.com.pl"
                  className="w-16 h-16 object-contain select-none"
                  style={{
                    filter:
                      "brightness(0) invert(1) sepia(1) saturate(5) hue-rotate(5deg) drop-shadow(0 0 8px rgba(245,158,11,0.6))",
                  }}
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
                      maxLength={6}
                      disabled={guestLogin.isPending}
                    />
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
                  Odkryj skarb
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-green-800 dark:text-green-400 hover:text-green-900 dark:hover:text-green-300 hover:bg-green-100/50 dark:hover:bg-green-900/30"
                  onClick={() => setView("admin")}
                >
                  Panel administratora
                </Button>
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
                onClick={() => { setView("guest"); setLoginError(null); }}
              >
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <CardTitle className="text-2xl font-bold text-green-950 dark:text-green-300 text-center mt-2">Logowanie admina</CardTitle>
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

              <CardFooter>
                <Button
                  type="submit"
                  className="w-full bg-green-700 hover:bg-green-800 dark:bg-green-800 dark:hover:bg-green-700 text-white"
                  disabled={adminLogin.isPending || !username || !password}
                >
                  {adminLogin.isPending ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <User className="w-5 h-5 mr-2" />}
                  Zaloguj jako admin
                </Button>
              </CardFooter>
            </form>
          </>
        )}
      </Card>
    </div>
  );
}

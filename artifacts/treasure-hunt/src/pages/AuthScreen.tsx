import { useState } from "react";
import { useAdminLogin, useGuestLogin } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Key, User, ArrowLeft, Coins, AlertCircle } from "lucide-react";
import { getOrCreateGuestToken, type GuestData } from "@/App";

type AuthScreenProps = {
  onLoginAdmin: (user: { id: number; name: string; role: string }) => void;
  onLoginGuest: (guestData: GuestData) => void;
};

export default function AuthScreen({ onLoginAdmin, onLoginGuest }: AuthScreenProps) {
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
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-gradient-to-br from-green-900 to-amber-600 p-4">
      {/* Force-light card: explicit white bg + dark text so dark-mode CSS vars don't invert the card */}
      <Card className="w-full max-w-md shadow-2xl border-none bg-white backdrop-blur [color-scheme:light]">
        {view === "guest" ? (
          <>
            <CardHeader className="text-center space-y-2">
              <div className="mx-auto w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mb-4">
                <Coins className="w-8 h-8 text-amber-500" />
              </div>
              <CardTitle className="text-3xl font-bold text-green-950">Pysne.com.pl</CardTitle>
              <CardDescription className="text-green-800 text-lg">Wpisz kod, aby odkryć skarb</CardDescription>
            </CardHeader>
            <form onSubmit={handleGuestSubmit}>
              <CardContent>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Input
                      id="code"
                      placeholder="KOD SKARBU"
                      className="text-center text-2xl uppercase tracking-widest h-14 border-amber-300 bg-white text-gray-900 placeholder:text-gray-400 focus-visible:ring-amber-500"
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
                  className="text-green-800 hover:text-green-900 hover:bg-green-100/50"
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
                className="w-8 h-8 absolute top-4 left-4 text-green-800 hover:text-green-900 hover:bg-green-100"
                onClick={() => { setView("guest"); setLoginError(null); }}
              >
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <CardTitle className="text-2xl font-bold text-green-950 text-center mt-2">Logowanie admina</CardTitle>
            </CardHeader>
            <form onSubmit={handleAdminSubmit}>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="username" className="text-gray-700 font-medium">Nazwa użytkownika</Label>
                  <Input
                    id="username"
                    value={username}
                    onChange={(e) => { setUsername(e.target.value); setLoginError(null); }}
                    disabled={adminLogin.isPending}
                    className="bg-white text-gray-900 border-green-300 placeholder:text-gray-400 focus-visible:ring-green-500"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password" className="text-gray-700 font-medium">Hasło</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setLoginError(null); }}
                    disabled={adminLogin.isPending}
                    className="bg-white text-gray-900 border-green-300 placeholder:text-gray-400 focus-visible:ring-green-500"
                  />
                </div>

                {/* Inline error message — always visible, high-contrast */}
                {loginError && (
                  <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {loginError}
                  </div>
                )}
              </CardContent>

              <CardFooter className="flex flex-col gap-4">
                <Button
                  type="submit"
                  className="w-full bg-green-700 hover:bg-green-800 text-white"
                  disabled={adminLogin.isPending || !username || !password}
                >
                  {adminLogin.isPending ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <User className="w-5 h-5 mr-2" />}
                  Zaloguj jako admin
                </Button>
              </CardFooter>
            </form>

            {/* Test credentials hint */}
            <div className="px-6 pb-6">
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <div className="font-semibold text-amber-800 mb-1.5">Dane testowe:</div>
                <div className="flex items-center gap-2">
                  <span className="text-amber-700 w-12 text-xs">login:</span>
                  <code className="font-mono font-bold bg-white/70 px-2 py-0.5 rounded border border-amber-200">czosnek</code>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-amber-700 w-12 text-xs">hasło:</span>
                  <code className="font-mono font-bold bg-white/70 px-2 py-0.5 rounded border border-amber-200">Aszwarganda666!@#</code>
                </div>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

import { useState, useEffect } from "react";
import { useAdminLogin, useGuestLogin, useListMarkers, useGetStats } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Key, User, ArrowLeft, Coins } from "lucide-react";

type AuthScreenProps = {
  onLoginAdmin: (user: { id: number; name: string; role: string }) => void;
  onLoginGuest: (guestData: { markerId: number; code: string; markerTitle: string; markerDescription: string; imageUrl: string | null; lat: number; lng: number }) => void;
};

export default function AuthScreen({ onLoginAdmin, onLoginGuest }: AuthScreenProps) {
  const [view, setView] = useState<"guest" | "admin">("guest");
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
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
    adminLogin.mutate(
      { data: { username, password } },
      {
        onSuccess: (data) => {
          onLoginAdmin(data);
          toast({ title: "Zalogowano", description: `Witaj ${data.name}!` });
        },
        onError: () => {
          toast({ variant: "destructive", title: "Błąd", description: "Nieprawidłowe dane logowania." });
        },
      }
    );
  };

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-gradient-to-br from-green-900 to-amber-600 p-4">
      <Card className="w-full max-w-md shadow-2xl border-none bg-white/95 backdrop-blur">
        {view === "guest" ? (
          <>
            <CardHeader className="text-center space-y-2">
              <div className="mx-auto w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mb-4">
                <Coins className="w-8 h-8 text-amber-500" />
              </div>
              <CardTitle className="text-3xl font-bold text-green-950">Treasure Hunt</CardTitle>
              <CardDescription className="text-green-800/70 text-lg">Wpisz kod, aby odkryć skarb</CardDescription>
            </CardHeader>
            <form onSubmit={handleGuestSubmit}>
              <CardContent>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Input
                      id="code"
                      placeholder="KOD SKARBU"
                      className="text-center text-2xl uppercase tracking-widest h-14 border-amber-200 focus-visible:ring-amber-500"
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
                className="w-8 h-8 absolute top-4 left-4 text-green-800"
                onClick={() => setView("guest")}
              >
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <CardTitle className="text-2xl font-bold text-green-950 text-center mt-2">Logowanie admina</CardTitle>
            </CardHeader>
            <form onSubmit={handleAdminSubmit}>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="username">Nazwa użytkownika</Label>
                  <Input
                    id="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    disabled={adminLogin.isPending}
                    className="border-green-200 focus-visible:ring-green-500"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Hasło</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={adminLogin.isPending}
                    className="border-green-200 focus-visible:ring-green-500"
                  />
                </div>
              </CardContent>
              <CardFooter>
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
          </>
        )}
      </Card>
    </div>
  );
}

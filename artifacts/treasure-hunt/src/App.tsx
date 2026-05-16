import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEffect, useState } from "react";
import { guestLogin } from "@workspace/api-client-react";
import NotFound from "@/pages/not-found";
import AuthScreen from "@/pages/AuthScreen";
import AppScreen from "@/pages/AppScreen";

const queryClient = new QueryClient();

export type GuestData = {
  markerId: number;
  code: string;
  markerTitle: string;
  markerDescription: string;
  imageUrl: string | null;
  lat: number;
  lng: number;
  discoveredAt: string;
  imageExpiresAt: string;
  imageExpired: boolean;
  markerExpiresAt: string;
};

const GUEST_SESSION_KEY = "th_guest_session";
const GUEST_TOKEN_KEY = "th_guest_token";

// Generate (or read) a stable per-browser guest identity. Used by the server
// to track per-user discovery time so the 2-hour image window survives refresh.
export function getOrCreateGuestToken(): string {
  let token = localStorage.getItem(GUEST_TOKEN_KEY);
  if (!token) {
    token = (typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem(GUEST_TOKEN_KEY, token);
  }
  return token;
}

function MainApp() {
  const [user, setUser] = useState<{ id: number; name: string; role: string } | null>(null);
  const [guestData, setGuestData] = useState<GuestData | null>(null);
  const [hydrating, setHydrating] = useState(true);

  // On reload, if we have a saved guest session, ask the server for fresh state.
  // The server returns the original discoveredAt (per-user), so the timer keeps counting.
  useEffect(() => {
    const saved = localStorage.getItem(GUEST_SESSION_KEY);
    if (!saved) {
      setHydrating(false);
      return;
    }
    try {
      const { code } = JSON.parse(saved) as { code: string };
      const guestToken = getOrCreateGuestToken();
      guestLogin({ code, guestToken })
        .then((data) => setGuestData(data))
        .catch(() => localStorage.removeItem(GUEST_SESSION_KEY))
        .finally(() => setHydrating(false));
    } catch {
      localStorage.removeItem(GUEST_SESSION_KEY);
      setHydrating(false);
    }
  }, []);

  const handleGuestLogin = (data: GuestData) => {
    setGuestData(data);
    localStorage.setItem(GUEST_SESSION_KEY, JSON.stringify({ code: data.code }));
  };

  const handleLogout = () => {
    setUser(null);
    setGuestData(null);
    localStorage.removeItem(GUEST_SESSION_KEY);
  };

  if (hydrating) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-gradient-to-br from-green-900 to-amber-600">
        <div className="text-white text-lg animate-pulse">Ładowanie...</div>
      </div>
    );
  }

  if (!user && !guestData) {
    return <AuthScreen onLoginAdmin={setUser} onLoginGuest={handleGuestLogin} />;
  }

  return <AppScreen user={user} guestData={guestData} onLogout={handleLogout} />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={MainApp} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

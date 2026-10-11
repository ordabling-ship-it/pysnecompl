import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
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
  markerExpiresAt: string;
};

const GUEST_SESSION_KEY = "th_guest_session";
const GUEST_TOKEN_KEY = "th_guest_token";
const TERMS_ACCEPTED_KEY = "pysne_terms_accepted_v1";

// Stable per-browser guest identity (kept for backwards compatibility with the
// API contract — the server still accepts it but the marker timer is now
// shared, not per-guest).
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

function getAutoTheme(): "light" | "dark" {
  const h = new Date().getHours();
  return h >= 6 && h < 20 ? "light" : "dark";
}

function MainApp() {
  const pathname = window.location.pathname.replace(/\/$/, "") || "/";
  const routeMode = pathname === "/panel" ? "panel" : pathname === "/activate" ? "activate" : "player";
  const tenantSlug = routeMode === "player" ? pathname.split("/").filter(Boolean)[0]?.toLowerCase() : undefined;
  const activationToken = routeMode === "activate" ? new URLSearchParams(window.location.search).get("token") : null;
  const layoutPreview = import.meta.env.DEV && new URLSearchParams(window.location.search).has("layout-preview");
  const [user, setUser] = useState<{ id: number; name: string; role: string; slug?: string; pinBalance?: number } | null>(
    layoutPreview ? { id: 0, name: "Podgląd administratora", role: "admin", slug: "podglad", pinBalance: 10 } : null,
  );
  const [guestData, setGuestData] = useState<GuestData | null>(null);
  const [hydrating, setHydrating] = useState(!layoutPreview);
  const [termsAccepted, setTermsAccepted] = useState(() => localStorage.getItem(TERMS_ACCEPTED_KEY) === "true");

  // Welcome notification shown after admin login at bottom-center of screen.
  const [loginMsg, setLoginMsg] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // ── Theme management (light / dark) ──────────────────────────────────────
  // Priority: manual override in localStorage → time-based auto selection.
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("th_theme");
    if (saved === "light" || saved === "dark") return saved;
    return getAutoTheme();
  });

  // Apply/remove the .dark class on <html> whenever theme changes.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // Auto-switch every minute unless the user has manually overridden.
  useEffect(() => {
    if (localStorage.getItem("th_theme_manual") === "true") return;
    const check = () => setTheme(getAutoTheme());
    check();
    const id = window.setInterval(check, 60_000);
    return () => window.clearInterval(id);
  }, []);

  const handleToggleTheme = () => {
    setTheme((t) => {
      const next: "light" | "dark" = t === "light" ? "dark" : "light";
      localStorage.setItem("th_theme", next);
      localStorage.setItem("th_theme_manual", "true");
      return next;
    });
  };
  // ─────────────────────────────────────────────────────────────────────────

  // Restore the signed admin cookie first, then fall back to the saved guest code.
  useEffect(() => {
    if (layoutPreview || (routeMode === "player" && !termsAccepted) || routeMode === "activate") return;
    let mounted = true;
    const restoreSession = async () => {
      try {
        const response = await fetch("/api/auth/session", {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (response.ok) {
          const admin = await response.json() as { id: number; name: string; role: string; slug?: string; pinBalance?: number };
          if (mounted) setUser(admin);
          localStorage.removeItem(GUEST_SESSION_KEY);
          return;
        }
      } catch {
        // A missing or expired admin cookie falls through to guest restoration.
      }

      if (routeMode !== "player") return;
      const saved = localStorage.getItem(GUEST_SESSION_KEY);
      if (!saved) return;
      try {
        const { code } = JSON.parse(saved) as { code: string };
        const guestToken = getOrCreateGuestToken();
        const guest = await guestLogin({ code, guestToken, tenantSlug });
        if (mounted) setGuestData(guest);
      } catch {
        localStorage.removeItem(GUEST_SESSION_KEY);
      }
    };

    void restoreSession().finally(() => {
      if (mounted) setHydrating(false);
    });
    return () => { mounted = false; };
  }, [layoutPreview, termsAccepted, routeMode, tenantSlug]);

  const handleAdminLogin = (data: { id: number; name: string; role: string; slug?: string; pinBalance?: number }) => {
    setUser(data);
    setLoginMsg(`Witaj, ${data.name}!`);
  };

  const handleGuestLogin = (data: GuestData) => {
    setGuestData(data);
    localStorage.setItem(GUEST_SESSION_KEY, JSON.stringify({ code: data.code }));
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {
      // Clear local admin state even if the server is temporarily unreachable.
    } finally {
      queryClient.clear();
      setUser(null);
      setGuestData(null);
      localStorage.removeItem(GUEST_SESSION_KEY);
    }
  };

  if (routeMode === "activate") {
    return <AuthScreen onLoginAdmin={handleAdminLogin} onLoginGuest={handleGuestLogin} mode="activate" activationToken={activationToken ?? ""} theme={theme} onToggleTheme={handleToggleTheme} />;
  }

  if (routeMode === "player" && !termsAccepted) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-gradient-to-br from-green-900 to-amber-600 p-4 dark:from-gray-900 dark:to-gray-800">
        <section className="w-full max-w-lg rounded-2xl bg-white p-7 text-center shadow-2xl dark:border dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 sm:p-9">
          <img src="/logo.png" alt="Pysne.com.pl" className="mx-auto mb-5 h-16 w-16 object-contain" />
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-400">Podchody 2.0</p>
          <h1 className="mb-3 text-2xl font-bold text-green-950 dark:text-green-300">Zanim rozpoczniesz grę</h1>
          <p className="mb-6 text-sm leading-6 text-gray-600 dark:text-gray-300">
            Zapoznaj się z zasadami bezpiecznej zabawy i korzystania z Pysne.com.pl. Udział w grze jest bezpłatny; zakupy dla administratorów są opcjonalne.
          </p>
          <div className="flex flex-col items-center gap-4">
            <a href="/regulamin.html" className="font-semibold text-green-800 underline underline-offset-4 hover:text-green-950 dark:text-green-300 dark:hover:text-green-100">
              Przeczytaj regulamin
            </a>
            <button
              type="button"
              onClick={() => {
                localStorage.setItem(TERMS_ACCEPTED_KEY, "true");
                setTermsAccepted(true);
              }}
              className="w-full rounded-xl bg-green-700 px-5 py-3 font-semibold text-white shadow hover:bg-green-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-700"
            >
              Akceptuję regulamin i przechodzę dalej
            </button>
          </div>
        </section>
      </div>
    );
  }

  if (hydrating) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-gradient-to-br from-green-900 to-amber-600">
        <div className="text-white text-lg animate-pulse">Ładowanie...</div>
      </div>
    );
  }

  if (!user && !guestData) {
    return (
      <AuthScreen
        onLoginAdmin={handleAdminLogin}
        onLoginGuest={handleGuestLogin}
        tenantSlug={tenantSlug}
        mode={routeMode === "panel" ? "panel" : "player"}
        theme={theme}
        onToggleTheme={handleToggleTheme}
      />
    );
  }

  return (
    <AppScreen
      user={user}
      guestData={guestData}
      onLogout={handleLogout}
      theme={theme}
      onToggleTheme={handleToggleTheme}
      loginMsg={loginMsg}
      onLoginMsgDismiss={() => setLoginMsg(null)}
      layoutPreview={layoutPreview}
    />
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/panel" component={MainApp} />
      <Route path="/activate" component={MainApp} />
      <Route path="/" component={MainApp} />
      <Route path="/:tenantSlug" component={MainApp} />
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

import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useState } from "react";
import NotFound from "@/pages/not-found";
import AuthScreen from "@/pages/AuthScreen";
import AppScreen from "@/pages/AppScreen";

const queryClient = new QueryClient();

function MainApp() {
  const [user, setUser] = useState<{ id: number; name: string; role: string } | null>(null);
  const [guestData, setGuestData] = useState<{ markerId: number; code: string; markerTitle: string; markerDescription: string; imageUrl: string | null; lat: number; lng: number } | null>(null);

  const handleLogout = () => {
    setUser(null);
    setGuestData(null);
  };

  if (!user && !guestData) {
    return <AuthScreen onLoginAdmin={setUser} onLoginGuest={setGuestData} />;
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

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  useListMarkers,
  useGetStats,
  useCreateMarker,
  useDeleteMarker,
  useGetDiscoveries,
  useResetDiscoveries,
  getListMarkersQueryKey,
  getGetStatsQueryKey,
  getGetDiscoveriesQueryKey,
} from "@workspace/api-client-react";
import type { Discoveries, Marker, Stats } from "@workspace/api-client-react";
import { CREATOR_PIN_PACKAGES, FIRST_PURCHASE_BONUS_PINS, type CreatorPinPackageId } from "@workspace/api-zod/pin-packages";
import type { GuestData } from "@/App";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  LogOut, Search, Shield, User, Image as ImageIcon, Trash2, RefreshCcw,
  BarChart3, List, Loader2, Copy, Eye, X, ChevronRight, ChevronLeft, Clock,
  Check, ChevronDown, RotateCcw, Compass, MapPin, Sun, Moon, ChevronUp,
  Plus,
} from "lucide-react";

// ─────────────────────────────────────────────
// Map icon SVGs
// ─────────────────────────────────────────────
const goldCoinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#f59e0b" stroke="#b45309" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><circle cx="12" cy="12" r="10"/><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
const adminPinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#22c55e" stroke="#166534" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
// Red pin used while a marker's code is actively counting down (admin view).
const redPinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ef4444" stroke="#7f1d1d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
const expiredPinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#a1a1aa" stroke="#52525b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
const searchPinHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#3b82f6" stroke="#1e40af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 drop-shadow-md"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;

const createIcon = (html: string) => L.divIcon({
  html,
  className: "bg-transparent border-none",
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  popupAnchor: [0, -32],
});

// ─────────────────────────────────────────────
// Image compression: resize to max 800×600, then
// iteratively reduce JPEG quality until under 1 MB.
// ─────────────────────────────────────────────
async function processImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX_W = 800;
        const MAX_H = 600;
        let { width, height } = img;
        const ratio = Math.min(MAX_W / width, MAX_H / height, 1);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas not supported"));
        ctx.drawImage(img, 0, 0, width, height);

        // Start at quality 0.82 and reduce until dataUrl fits inside 1 MB
        const TARGET_BYTES = 1024 * 1024;
        let quality = 0.82;
        let dataUrl = canvas.toDataURL("image/jpeg", quality);
        while (dataUrl.length * 0.75 > TARGET_BYTES && quality > 0.3) {
          quality -= 0.08;
          dataUrl = canvas.toDataURL("image/jpeg", quality);
        }
        if (dataUrl.length > 1_500_000) {
          reject(new Error("Image is larger than the upload limit"));
          return;
        }
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error("Invalid image"));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ─────────────────────────────────────────────
// Clipboard helper with textarea fallback
// ─────────────────────────────────────────────
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// Timer helpers
// ─────────────────────────────────────────────

/** Format remaining ms as mm:ss (used for treasure code expiry timer). */
function formatCodeTimer(ms: number): string {
  if (ms <= 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/** Format an ISO timestamp as "hh:mm dd/mm/yy" for the admin "Activation date" field. */
function formatActivationDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)}`;
}

/** Format an ISO timestamp as "hh:mm:ss" — used in the discoveries log entries. */
function formatLogTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format an ISO timestamp as "dd/mm/yy" — used for the "Last reset" label. */
function formatShortDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)}`;
}

const auditEventLabels: Record<string, string> = {
  account_created: "Utworzono konto",
  account_activated: "Aktywowano konto",
  account_invite_issued: "Wysłano zaproszenie do konta",
  account_password_reset: "Zmieniono hasło do konta",
  marker_created: "Dodano skarb",
  marker_archived: "Zarchiwizowano skarb",
  treasure_activated: "Odbiorca rozpoczął grę",
  guest_code_entered: "Odbiorca wpisał token",
  code_redeemed: "Użyto tokenu",
  admin_login: "Logowanie do panelu",
  master_bootstrapped: "Utworzono konto Master Admina",
  moderator_created: "Utworzono konto Moderatora",
  pin_pack_payment_started: "Rozpoczęto płatność za pakiet pinezek",
  pin_pack_payment_failed: "Płatność za pakiet pinezek nie powiodła się",
  pin_pack_payment_expired: "Sesja płatności wygasła",
  pin_pack_purchased: "Kupiono pakiet pinezek",
  pin_pack_refunded: "Zwrócono płatność za pakiet pinezek",
};

function auditEventLabel(eventType: string): string {
  return auditEventLabels[eventType] ?? eventType.replaceAll("_", " ");
}

function auditActorLabel(event: { eventType: string; actorName: string | null }): string {
  if (event.actorName) return event.actorName;
  return event.eventType === "treasure_activated" || event.eventType === "guest_code_entered" ? "Odbiorca" : "System";
}

function accountRoleLabel(role: string): string {
  if (role === "admin") return "Kreator";
  if (role === "moderator") return "Moderator";
  if (role === "master_admin") return "Master Admin";
  return "Inna rola";
}

// ─────────────────────────────────────────────
// Guest Leaflet popup HTML (static — the single
// countdown lives in the bottom-center chip).
// ─────────────────────────────────────────────
function escapePopupHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function safePopupImageUrl(value: string | null): string | null {
  if (!value) return null;
  if (/^data:image\/jpeg;base64,[A-Za-z0-9+/]*={0,2}$/.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

function buildGuestPopupHtml(g: GuestData, isDark = false): string {
  const bg        = isDark ? "#1f2937" : "#ffffff";
  const titleClr  = isDark ? "#fbbf24" : "#d97706";
  const textClr   = isDark ? "#d1d5db" : "#374151";
  const badgeBg   = isDark ? "#374151" : "#fef3c7";
  const badgeClr  = isDark ? "#fde68a" : "#92400e";

  const imageUrl = safePopupImageUrl(g.imageUrl);
  const imageBlock = imageUrl
    ? `<img src="${escapePopupHtml(imageUrl)}" style="width:100%;height:96px;object-fit:cover;border-radius:4px;margin-bottom:8px"/>`
    : "";

  return `
    <div style="padding:8px;min-width:230px;background:${bg};border-radius:4px">
      ${imageBlock}
      <h3 style="font-weight:700;font-size:15px;color:${titleClr}">${escapePopupHtml(g.markerTitle)}</h3>
      <p style="font-size:12px;color:${textClr};margin-top:4px;font-style:italic">💡 ${escapePopupHtml(g.markerDescription)}</p>
      <span style="display:inline-block;margin-top:8px;padding:2px 8px;background:${badgeBg};color:${badgeClr};border-radius:9999px;font-size:11px;font-weight:700;text-transform:uppercase">Skarb odkryty!</span>
      <button onclick="window.__thNavigate(${g.lat}, ${g.lng})"
        style="margin-top:10px;width:100%;background:#2563eb;color:#fff;font-size:13px;font-weight:600;padding:7px 10px;border:none;border-radius:6px;cursor:pointer">
        🧭 Nawiguj
      </button>
    </div>
  `;
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
type AppScreenProps = {
  user: { id: number; name: string; role: string; slug?: string; pinBalance?: number; firstPurchaseBonusGranted?: boolean; canAccessAnalytics?: boolean } | null;
  guestData: GuestData | null;
  onLogout: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  loginMsg: string | null;
  onLoginMsgDismiss: () => void;
  layoutPreview?: boolean;
};

type MarkerItem = {
  id: number;
  title: string;
  description: string;
  code: string;
  lat: number;
  lng: number;
  // Null = code timer not started yet (no guest has entered the code).
  expiresAt: string | null;
  // Null until the first guest activates the code; mirrors the moment expiresAt was set.
  activatedAt: string | null;
  redemptionCount: number;
  imageUrl?: string | null;
};

// ─────────────────────────────────────────────
// MarkerRow: individual admin list item with
// live mm:ss expiry countdown, copy button, and
// image preview trigger.
// ─────────────────────────────────────────────
function MarkerRow({
  m,
  onFly,
  onDelete,
  onCopy,
  onPreview,
  isSelected,
}: {
  m: MarkerItem;
  onFly: (lat: number, lng: number, id: number) => void;
  onDelete: (id: number) => void;
  onCopy: (code: string) => void;
  onPreview: (m: MarkerItem) => void;
  isSelected: boolean;
}) {
  // Each row manages its own 1-second tick so we don't re-render the whole list
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // When this row is selected (via map-marker click), scroll it into view inside
  // the right-hand sidebar list so the admin instantly sees it.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [isSelected]);

  // Three states:
  //   * expiresAt === null → code is set but timer hasn't started (no guest activated it yet)
  //   * remaining > 0       → countdown active
  //   * remaining <= 0      → code expired (greyed out for admin, hidden from guests)
  const notStarted = m.expiresAt === null;
  const expiresMs = m.expiresAt ? new Date(m.expiresAt).getTime() : 0;
  const remaining = expiresMs - now;
  const isExpired = !notStarted && remaining <= 0;

  return (
    <div
      ref={rowRef}
      className={`p-3 rounded-md text-sm transition-all cursor-pointer ${
        isSelected
          ? "border-2 border-green-600 shadow-md bg-white dark:bg-gray-700"
          : isExpired
            ? "border bg-gray-50 dark:bg-gray-700/50 border-gray-100 dark:border-gray-600 opacity-60"
            : "border bg-white dark:bg-gray-700 dark:border-gray-600 hover:border-green-300 dark:hover:border-green-600 hover:shadow-sm"
      }`}
      onClick={() => onFly(m.lat, m.lng, m.id)}
    >
      {/* Title row */}
      <div className="flex justify-between items-start mb-1 gap-1">
        <span className={`font-semibold flex-1 min-w-0 truncate ${isExpired ? "text-gray-500 dark:text-gray-400" : "text-green-900 dark:text-green-400"}`}>
          {m.title}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          {/* Image preview button (only if has image) */}
          {m.imageUrl && (
            <Button
              variant="ghost"
              size="icon"
              className="w-6 h-6 text-blue-400 hover:text-blue-700 hover:bg-blue-50"
              title="Podgląd zdjęcia"
              onClick={(e) => { e.stopPropagation(); onPreview(m); }}
            >
              <Eye className="w-3 h-3" />
            </Button>
          )}
          {/* Hide button — the server archives the marker so history remains intact. */}
          <Button
            variant="ghost"
            size="icon"
            className="w-6 h-6 text-red-400 hover:text-red-700 hover:bg-red-50"
            title="Ukryj skarb"
            onClick={(e) => { e.stopPropagation(); onDelete(m.id); }}
          >
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </div>

      {/* Single row: code | copy | timer | date */}
      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        <code
          className={`px-2 py-0.5 rounded text-xs font-mono font-bold tracking-widest ${
            isExpired ? "bg-gray-200 dark:bg-gray-600 text-gray-400 dark:text-gray-500 line-through" : "bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300"
          }`}
        >
          {m.code}
        </code>

        <Button
          variant="ghost"
          size="icon"
          className="w-6 h-6 text-gray-400 hover:text-green-700 hover:bg-green-50"
          title="Kopiuj token"
          onClick={(e) => { e.stopPropagation(); onCopy(m.code); }}
        >
          <Copy className="w-3.5 h-3.5" />
        </Button>

        {/* Timer chip */}
        <span className={`flex items-center gap-1 text-xs font-mono font-semibold ${
          notStarted ? "text-gray-500 dark:text-gray-400" : isExpired ? "text-gray-400 dark:text-gray-500" : "text-red-500 dark:text-red-400"
        }`}>
          <Clock className="w-3 h-3" />
          {notStarted ? "Nieaktywny (60:00)" : isExpired ? "Wygasły" : formatCodeTimer(remaining)}
        </span>

        {/* Activation date — right-aligned */}
        <span className="text-[11px] text-gray-400 dark:text-gray-500 ml-auto font-mono">
          {m.activatedAt ? formatActivationDate(m.activatedAt) : "—"}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Main AppScreen component
// ─────────────────────────────────────────────
export default function AppScreen({ user, guestData, onLogout, theme, onToggleTheme, loginMsg, onLoginMsgDismiss, layoutPreview = false }: AppScreenProps) {
  const { toast } = useToast();
  const [pinBalance, setPinBalance] = useState<number | null>(user?.pinBalance ?? null);
  const [firstPurchaseBonusGranted, setFirstPurchaseBonusGranted] = useState(user?.firstPurchaseBonusGranted ?? false);
  const [pinPurchaseOpen, setPinPurchaseOpen] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState<CreatorPinPackageId | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [paymentPending, setPaymentPending] = useState(false);
  const [managedUsers, setManagedUsers] = useState<Array<{ id: number; name: string; slug: string; role: string; parentUserId: number | null; pinBalance: number; totalPins: number; discoveries: number; redemptions: number }>>([]);
  const [globalOverview, setGlobalOverview] = useState<{ accounts: number; admins: number; moderators: number; markers: number; activatedMarkers: number; activeMarkers: number; expiredMarkers: number; totalRedemptions: number; creatorUsage: Array<{ id: number; name: string; slug: string; pinBalance: number; markers: number; activations: number; activeMarkers: number; redemptions: number }> } | null>(null);
  const [managedActivity, setManagedActivity] = useState<Array<{ id: number; eventType: string; createdAt: string; actorName: string | null; details: Record<string, string | number | boolean | null> }>>([]);
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
  const canManageAccounts = user?.role === "moderator" || user?.role === "master_admin";
  const loadManagedUsers = async () => {
    const response = await fetch("/api/control/users", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (response.ok) setManagedUsers(await response.json());
    const overviewResponse = await fetch("/api/control/overview", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (overviewResponse.ok) setGlobalOverview(await overviewResponse.json());
    const activityResponse = await fetch("/api/control/activity", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (activityResponse.ok) setManagedActivity(await activityResponse.json());
  };
  useEffect(() => {
    if (canManageAccounts && !layoutPreview) void loadManagedUsers();
  }, [canManageAccounts, layoutPreview]);
  const handleCreateManagedAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    setAccountError(null);
    setAccountBusy(true);
    try {
      const response = await fetch("/api/control/users", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username: accountName, role: accountRole }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Nie udało się utworzyć konta.");
      setAccountName(""); setCreatedInviteUrl(result.inviteUrl ?? null);
      await loadManagedUsers();
      toast({
        title: "Konto utworzone",
        description: `Zaproszenie dla ${result.name} ważne do ${new Date(result.inviteExpiresAt).toLocaleString("pl-PL")}.`,
      });
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
        method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ password: passwordResetValue }),
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error ?? "Nie udało się zmienić hasła.");
      }
      setPasswordResetTargetId(null); setPasswordResetValue(""); setPasswordResetConfirm("");
      await loadManagedUsers();
      toast({ title: "Hasło zmienione", description: `Nowe hasło dla ${targetName} zostało zapisane.` });
    } catch (error) {
      setPasswordResetError(error instanceof Error ? error.message : "Nie udało się zmienić hasła.");
    } finally {
      setPasswordResetBusy(false);
    }
  };
  const handlePinCheckout = async (packageId: CreatorPinPackageId) => {
    setCheckoutError(null);
    setCheckoutBusy(packageId);
    try {
      const response = await fetch("/api/payments/checkout-session", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ packageId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Nie udało się rozpocząć płatności.");
      const checkoutUrl = new URL(result.url);
      if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.stripe.com") {
        throw new Error("Otrzymany adres płatności Stripe jest nieprawidłowy.");
      }
      window.location.assign(checkoutUrl.toString());
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Nie udało się rozpocząć płatności.");
      setCheckoutBusy(null);
    }
  };
  useEffect(() => {
    if (!user || user.role !== "admin" || layoutPreview) return;
    const url = new URL(window.location.href);
    const paymentResult = url.searchParams.get("payment");
    const sessionId = url.searchParams.get("session_id");
    const clearPaymentQuery = () => {
      url.searchParams.delete("payment");
      url.searchParams.delete("session_id");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    };
    if (paymentResult === "cancelled") {
      setPinPurchaseOpen(true);
      toast({ title: "Płatność anulowana", description: "Nie pobrano opłaty. Możesz wybrać pakiet ponownie." });
      clearPaymentQuery();
      return;
    }
    if (paymentResult !== "success" || !sessionId) return;

    let attempts = 0;
    let timer: number | undefined;
    let stopped = false;
    const checkPayment = async () => {
      try {
        const response = await fetch(`/api/payments/checkout-session/${encodeURIComponent(sessionId)}`, {
          credentials: "same-origin", headers: { Accept: "application/json" },
        });
        if (response.ok) {
          const result = await response.json();
          if (result.status === "paid") {
            if (stopped) return;
            setPinBalance(result.pinBalance);
            setFirstPurchaseBonusGranted(Boolean(result.firstPurchaseBonusGranted));
            setPaymentPending(false);
            toast({
              title: "Płatność potwierdzona",
              description: result.bonusPins > 0
                ? `Dodano ${result.bonusPins} pinezek bonusowych. Saldo obejmuje pakiet i bonus.`
                : "Nowe pinezki zostały dodane do Twojego konta.",
            });
            clearPaymentQuery();
            return;
          }
          if (result.status === "failed" || result.status === "expired") {
            if (stopped) return;
            setPaymentPending(false);
            setPinPurchaseOpen(true);
            setCheckoutError(result.status === "expired" ? "Sesja płatności wygasła. Wybierz pakiet ponownie." : "Płatność nie została zrealizowana. Możesz spróbować ponownie.");
            clearPaymentQuery();
            return;
          }
        }
      } catch {
        // Stripe webhook may still be processing; retry briefly below.
      }
      attempts += 1;
      if (stopped) return;
      if (attempts >= 20) {
        setPaymentPending(true);
        setPinPurchaseOpen(true);
        toast({ title: "Płatność jest potwierdzana", description: "Saldo zaktualizuje się po potwierdzeniu przez Stripe. Odśwież stronę za chwilę." });
        return;
      }
      timer = window.setTimeout(checkPayment, 1500);
    };
    void checkPayment();
    return () => { stopped = true; if (timer) window.clearTimeout(timer); };
  }, [user?.id, user?.role, layoutPreview, toast]);
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const themeRef = useRef(theme);
  const markersRef = useRef<Record<number, L.Marker>>({});
  const searchMarkerRef = useRef<L.Marker | null>(null);

  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [clickPos, setClickPos] = useState<{ lat: number; lng: number } | null>(null);
  const [isPickingLocation, setIsPickingLocation] = useState(false);
  const pickingLocationRef = useRef(false);
  const [saved, setSaved] = useState(false);

  // Form state
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newImg, setNewImg] = useState<string | null>(null);
  const [imgProcessing, setImgProcessing] = useState(false);
  // Briefly flashes a green check next to the image upload button after success.
  const [imgUploadedFlash, setImgUploadedFlash] = useState(false);

  // Selected marker (set by clicking a map marker — drives the bold-border row in the list).
  const [selectedMarkerId, setSelectedMarkerId] = useState<number | null>(null);

  // Stats filter — toggled by clicking the green "Aktywne" or grey "Wygasłe" stat tiles.
  // 'all'  → no filter | 'active' → expiresAt is null OR > now | 'expired' → expiresAt <= now
  const [statsFilter, setStatsFilter] = useState<"all" | "active" | "expired">("all");
  const [markerSearch, setMarkerSearch] = useState("");
  const [markerSort, setMarkerSort] = useState<"newest" | "name">("newest");


  // Image preview modal state (admin: view uploaded image for any marker)
  const [previewMarker, setPreviewMarker] = useState<MarkerItem | null>(null);

  // Address search (admin only)
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);

  // Stats & Discoveries section collapse (persisted to localStorage)
  const [statsOpen, setStatsOpen] = useState<boolean>(() => {
    return localStorage.getItem("th_stats_open_v2") === "true";
  });
  const toggleStats = () => {
    setStatsOpen((v) => {
      const next = !v;
      localStorage.setItem("th_stats_open_v2", String(next));
      return next;
    });
  };

  // Reverse-geocode cache: code → street label
  const geocacheRef = useRef<Map<string, string>>(new Map());
  const [streetLabels, setStreetLabels] = useState<Record<string, string>>((): Record<string, string> => layoutPreview
    ? { ZL0TE: "Wały Chrobrego", M0NET: "Park Żeromskiego" }
    : {});

  const isMobile = useIsMobile();
  // Sidebar open/closed for mobile. Default closed; synced to breakpoint.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    setSidebarCollapsed(isMobile);
  }, [isMobile]);

  const queryClient = useQueryClient();

  const isAdmin = user?.role === "admin" || user?.role === "moderator" || user?.role === "master_admin";
  const isCreator = user?.role === "admin";
  const hasUnlimitedPins = user?.role === "master_admin" || user?.role === "moderator";
  const previewMarkers = useMemo<Marker[]>(() => {
    const now = Date.now();
    return [
      { id: -1, title: "Złote jajko przy Wałach", description: "Szukaj przy dużym drzewie.", code: "ZL0TE", lat: 53.4288, lng: 14.5526, imageUrl: null, createdAt: new Date(now - 3_600_000).toISOString(), expiresAt: new Date(now + 2_870_000).toISOString(), activatedAt: new Date(now - 730_000).toISOString(), redemptionCount: 1 },
      { id: -2, title: "Tajemnicza skrzynka", description: "Rozejrzyj się w pobliżu fontanny.", code: "SK4RB", lat: 53.4323, lng: 14.5591, imageUrl: null, createdAt: new Date(now - 7_200_000).toISOString(), expiresAt: null, activatedAt: null, redemptionCount: 0 },
      { id: -3, title: "Moneta podróżnika", description: "Podążaj za wskazówką.", code: "M0NET", lat: 53.4247, lng: 14.5452, imageUrl: null, createdAt: new Date(now - 86_400_000).toISOString(), expiresAt: new Date(now - 3_600_000).toISOString(), activatedAt: new Date(now - 4_200_000).toISOString(), redemptionCount: 1 },
    ];
  }, []);
  const { data: liveMarkers = [] } = useListMarkers({
    query: { queryKey: getListMarkersQueryKey(), enabled: isAdmin && !layoutPreview },
  });
  const markers = layoutPreview ? previewMarkers : liveMarkers;
  const { data: liveStats } = useGetStats({
    query: { queryKey: getGetStatsQueryKey(), enabled: isAdmin && !layoutPreview },
  });
  const stats: Stats | undefined = layoutPreview
    ? { totalMarkers: 3, activeMarkers: 2, expiredMarkers: 1, totalRedemptions: 2 }
    : liveStats;
  const { data: liveDiscoveries } = useGetDiscoveries({
    // Auto-refresh so the counter and recent log stay live while the admin watches.
    query: { queryKey: getGetDiscoveriesQueryKey(), enabled: isAdmin && !layoutPreview, refetchInterval: layoutPreview ? false : 5000 },
  });
  const discoveries: Discoveries | undefined = layoutPreview
    ? {
        count: 2,
        lastResetAt: new Date().toISOString(),
        recent: [
          { code: "ZL0TE", activatedAt: new Date(Date.now() - 730_000).toISOString() },
          { code: "M0NET", activatedAt: new Date(Date.now() - 4_200_000).toISOString() },
        ],
      }
    : liveDiscoveries;

  const createMarker = useCreateMarker();
  const deleteMarker = useDeleteMarker();
  const resetDiscoveries = useResetDiscoveries();

  // Filtered marker list driven by the stats-tile toggle.
  // Source of truth for both the list rendering AND the map placement effect.
  const filteredMarkers = useMemo(() => {
    const now = Date.now();
    const query = markerSearch.trim().toLocaleLowerCase("pl-PL");
    const filtered = markers.filter((m) => {
      const expired = m.expiresAt !== null && new Date(m.expiresAt).getTime() <= now;
      const matchesStatus = statsFilter === "all" || (statsFilter === "active" ? !expired : expired);
      const matchesSearch = !query || m.title.toLocaleLowerCase("pl-PL").includes(query) || m.code.toLocaleLowerCase("pl-PL").includes(query);
      return matchesStatus && matchesSearch;
    });
    return filtered.sort((a, b) => markerSort === "name"
      ? a.title.localeCompare(b.title, "pl")
      : b.createdAt.localeCompare(a.createdAt));
  }, [markers, statsFilter, markerSearch, markerSort]);

  const startLocationSelection = () => {
    pickingLocationRef.current = true;
    setIsPickingLocation(true);
    if (isMobile) setSidebarCollapsed(true);
  };

  const showSaved = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // Open the device's default navigation app (Apple Maps on iOS, default on Android)
  const openNavigation = (lat: number, lng: number) => {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const url = isIOS
      ? `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`
      : `geo:${lat},${lng}?q=${lat},${lng}`;
    window.open(url, "_blank", "noopener");
  };

  // ── Copy code helper: shows toast on success ──
  const handleCopyCode = useCallback(async (code: string) => {
    const ok = await copyToClipboard(code);
    toast({
      title: ok ? "Token skopiowany" : "Nie udało się skopiować tokenu",
      description: ok ? `${code} jest w schowku` : "Spróbuj skopiować ręcznie.",
      variant: ok ? "default" : "destructive",
    });
  }, [toast]);

  // ── Keep themeRef in sync so map effects can read the latest theme ──
  useEffect(() => { themeRef.current = theme; }, [theme]);

  // ── Map init (no tile layer here — the tile layer effect below owns it) ──
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    mapRef.current = L.map(mapContainer.current).setView([53.4285, 14.5528], 14);

    if (isAdmin) {
      mapRef.current.on("click", (e) => {
        if (!pickingLocationRef.current) return;
        setClickPos({ lat: e.latlng.lat, lng: e.latlng.lng });
        pickingLocationRef.current = false;
        setIsPickingLocation(false);
        setIsSheetOpen(true);
      });
    }
    return () => {
      tileLayerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [isAdmin]);

  // ── Tile layer: swap between light OSM and dark CartoDB whenever theme or
  //    isAdmin changes. isAdmin is included so the layer is (re-)added after
  //    the map is recreated when the user switches role. ──
  useEffect(() => {
    if (!mapRef.current) return;
    tileLayerRef.current?.remove();
    tileLayerRef.current = L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      { attribution: "&copy; OpenStreetMap contributors" }
    ).addTo(mapRef.current);
  }, [theme, isAdmin]);

  // ── Wire navigate helper used by Leaflet popup HTML ──
  useEffect(() => {
    (window as unknown as { __thNavigate?: (lat: number, lng: number) => void }).__thNavigate = openNavigation;
    return () => { delete (window as unknown as { __thNavigate?: (lat: number, lng: number) => void }).__thNavigate; };
  }, []);

  // ── Guest map placement (split out so it doesn't re-run on admin/marker
  //    changes, and CRITICALLY does not re-run on the per-second `guestNow`
  //    tick — that re-run was tearing down and rebuilding the marker every
  //    second and felt like the map was locked. We key purely on markerId
  //    so a new guest session re-fires, but a re-render does not). ──
  useEffect(() => {
    if (!mapRef.current || !guestData) return;
    // Snapshot identity values into local consts so the cleanup closure doesn't
    // depend on the guestData object identity.
    const { markerId, lat, lng } = guestData;
    const popupHtml = buildGuestPopupHtml(guestData, themeRef.current === "dark");
    const marker = L.marker([lat, lng], { icon: createIcon(redPinHtml) })
      .addTo(mapRef.current)
      .bindPopup(popupHtml);
    markersRef.current[markerId] = marker;
    mapRef.current.flyTo([lat, lng], 16);
    marker.openPopup();
    return () => {
      marker.remove();
      delete markersRef.current[markerId];
    };
    // Intentionally only depend on the marker identity. Re-renders from the
    // 1-second countdown tick must NOT re-trigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guestData?.markerId]);

  // ── Update guest popup colours when theme changes (without rebuilding the marker) ──
  useEffect(() => {
    if (!guestData) return;
    const marker = markersRef.current[guestData.markerId];
    marker?.setPopupContent(buildGuestPopupHtml(guestData, theme === "dark"));
  }, [theme, guestData]);

  // ── Admin map placement (fires when admin markers list or theme changes). ──
  useEffect(() => {
    if (!mapRef.current || !isAdmin) return;
    // Tear down any previous admin pins before re-rendering.
    Object.values(markersRef.current).forEach((m) => m.remove());
    markersRef.current = {};
    const dark = theme === "dark";
    const popupBg    = dark ? "#1f2937" : "#ffffff";
    const descClr    = dark ? "#9ca3af" : "#6b7280";
    const codePanBg  = dark ? "#374151" : "#f3f4f6";
    filteredMarkers.forEach((m) => {
      // Three pin colours:
      //   - grey   → expired (timer started AND past)
      //   - red    → counting down (timer started, still in the future)
      //   - green  → not yet activated by any guest (expiresAt is null)
      const expired = m.expiresAt !== null && new Date(m.expiresAt) < new Date();
      const counting = m.expiresAt !== null && !expired;
      const pinHtml = expired ? expiredPinHtml : counting ? redPinHtml : adminPinHtml;
      const titleClr = expired ? (dark ? "#6b7280" : "#9ca3af") : (dark ? "#6ee7b7" : "#166534");
      const codeClr  = expired ? (dark ? "#6b7280" : "#9ca3af") : (dark ? "#6ee7b7" : "#15803d");
      const imageUrl = safePopupImageUrl(m.imageUrl ?? null);
      const imgHtml = imageUrl
        ? `<img src="${escapePopupHtml(imageUrl)}" style="width:100%;height:80px;object-fit:cover;border-radius:4px;margin-bottom:6px"/>`
        : `<div style="width:100%;height:40px;display:flex;align-items:center;justify-content:center;color:${descClr};font-size:11px;font-style:italic;margin-bottom:6px">Brak zdjęcia</div>`;
      const marker = L.marker([m.lat, m.lng], {
        icon: createIcon(pinHtml),
        opacity: expired ? 0.55 : 1,
      })
        .addTo(mapRef.current!)
        .bindPopup(`
          <div style="padding:8px;min-width:200px;background:${popupBg};border-radius:4px">
            ${imgHtml}
            <h3 style="font-weight:700;font-size:14px;color:${titleClr}">${escapePopupHtml(m.title)}${expired ? " (Wygasły)" : ""}</h3>
            <p style="font-size:12px;color:${descClr};margin-top:4px">${escapePopupHtml(m.description)}</p>
            <div style="margin-top:8px;background:${codePanBg};padding:6px;border-radius:4px;text-align:center">
              <code style="font-family:monospace;font-weight:700;letter-spacing:0.1em;color:${codeClr};${expired ? "text-decoration:line-through" : ""}">${escapePopupHtml(m.code)}</code>
            </div>
          </div>
        `);
      // Click → highlight the corresponding row in the right-hand list.
      marker.on("click", () => setSelectedMarkerId(m.id));
      markersRef.current[m.id] = marker;
    });
  }, [isAdmin, filteredMarkers, theme]);

  const handleCreateMarker = (e: React.FormEvent) => {
    e.preventDefault();
    if (layoutPreview) return;
    if (!clickPos || !newTitle || !newDesc) return;
    createMarker.mutate(
      { data: { title: newTitle, description: newDesc, lat: clickPos.lat, lng: clickPos.lng, imageUrl: newImg } },
      {
        onSuccess: async (created) => {
          queryClient.invalidateQueries({ queryKey: getListMarkersQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
          if (isCreator) setPinBalance((balance) => balance == null ? balance : Math.max(0, balance - 1));
          showSaved();
          const ok = await copyToClipboard(created.code);
          toast({
            title: "Skarb dodany!",
            description: ok ? `Token ${created.code} skopiowany do schowka` : `Token: ${created.code}`,
          });
          setIsSheetOpen(false);
          setNewTitle("");
          setNewDesc("");
          setNewImg(null);
        },
        onError: (error) => {
          if ((error as { status?: number }).status === 402) setPinPurchaseOpen(true);
        },
      }
    );
  };

  const handleDeleteMarker = (id: number) => {
    if (layoutPreview) return;
    deleteMarker.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMarkersQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
          toast({ title: "Skarb ukryty" });
          showSaved();
        },
      }
    );
  };

  // Image upload: compress, preview. Hidden file input is re-triggered by buttons.
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImgProcessing(true);
    try {
      const dataUrl = await processImageFile(file);
      setNewImg(dataUrl);
      // Flash a green checkmark for ~2s to confirm the upload succeeded.
      setImgUploadedFlash(true);
      window.setTimeout(() => setImgUploadedFlash(false), 2000);
    } catch {
      toast({ variant: "destructive", title: "Błąd zdjęcia", description: "Nie można przetworzyć obrazu." });
    } finally {
      setImgProcessing(false);
      e.target.value = "";
    }
  };

  const flyToMarker = (lat: number, lng: number, id: number) => {
    setSelectedMarkerId(id);
    mapRef.current?.flyTo([lat, lng], 18);
    setTimeout(() => { markersRef.current[id]?.openPopup(); }, 500);
  };

  const handleResetDiscoveries = () => {
    if (layoutPreview) return;
    resetDiscoveries.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDiscoveriesQueryKey() });
        toast({ title: "Licznik odkryć zresetowany" });
      },
    });
  };

  const handleAddressSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || !mapRef.current) return;
    setSearching(true);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=pl&q=${encodeURIComponent(searchQuery + ", Szczecin")}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const data = await res.json();
      if (!Array.isArray(data) || !data.length) {
        toast({ variant: "destructive", title: "Nie znaleziono", description: "Brak wyników dla tej ulicy." });
        return;
      }
      const lat = parseFloat(data[0].lat);
      const lng = parseFloat(data[0].lon);
      mapRef.current.flyTo([lat, lng], 16);
      if (searchMarkerRef.current) searchMarkerRef.current.remove();
      searchMarkerRef.current = L.marker([lat, lng], { icon: createIcon(searchPinHtml) })
        .addTo(mapRef.current)
        .bindPopup(`<div style="padding:4px"><b>📍 ${escapePopupHtml(String(data[0].display_name ?? ""))}</b></div>`)
        .openPopup();
    } catch {
      toast({ variant: "destructive", title: "Błąd", description: "Nie udało się wyszukać adresu." });
    } finally {
      setSearching(false);
    }
  };

  // ─────────────────────────────────────────────
  // Login notification: auto-dismiss after 3 s
  // ─────────────────────────────────────────────
  useEffect(() => {
    if (!loginMsg) return;
    const id = window.setTimeout(() => onLoginMsgDismiss(), 3000);
    return () => window.clearTimeout(id);
  }, [loginMsg, onLoginMsgDismiss]);

  // ─────────────────────────────────────────────
  // Reverse-geocode recent activations (Nominatim)
  // ─────────────────────────────────────────────
  useEffect(() => {
    if (layoutPreview) return;
    if (!discoveries?.recent?.length || !markers.length) return;
    for (const r of discoveries.recent) {
      if (geocacheRef.current.has(r.code)) continue;
      const marker = markers.find((m) => m.code === r.code);
      if (!marker) {
        geocacheRef.current.set(r.code, "Nieznana lokalizacja");
        setStreetLabels((p) => ({ ...p, [r.code]: "Nieznana lokalizacja" }));
        continue;
      }
      (async () => {
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${marker.lat}&lon=${marker.lng}`,
            { headers: { Accept: "application/json" } }
          );
          const data = await res.json() as { address?: Record<string, string>; display_name?: string };
          const street =
            data.address?.road ??
            data.address?.pedestrian ??
            data.address?.path ??
            data.display_name?.split(",")[0] ??
            "Nieznana lokalizacja";
          geocacheRef.current.set(r.code, street);
          setStreetLabels((p) => ({ ...p, [r.code]: street }));
        } catch {
          geocacheRef.current.set(r.code, "Nieznana lokalizacja");
          setStreetLabels((p) => ({ ...p, [r.code]: "Nieznana lokalizacja" }));
        }
      })();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discoveries?.recent, markers, layoutPreview]);

  // ─────────────────────────────────────────────
  // Guest: code expiry timer in topbar info chip
  // ─────────────────────────────────────────────
  const [guestNow, setGuestNow] = useState(Date.now());
  useEffect(() => {
    if (!guestData) return;
    const id = window.setInterval(() => setGuestNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [guestData]);

  return (
    <div className="flex flex-col h-[100dvh] w-full relative">


      {/* ── Map + overlays ── */}
      <div className="flex-1 relative bg-slate-100 z-0">
        <div id="map" ref={mapContainer} className="absolute inset-0 w-full h-full" />

        {isAdmin && (
          <div className="absolute top-3 left-14 z-[1200] flex items-center gap-2">
            <Button
              type="button"
              onClick={startLocationSelection}
              className="h-10 rounded-xl bg-green-700 px-3.5 text-sm font-semibold text-white shadow-lg hover:bg-green-800"
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Dodaj skarb
            </Button>
            {user?.role === "admin" && <a href="/marketplace/manage" className="inline-flex h-10 items-center rounded-xl border border-white/70 bg-white/95 px-3 text-sm font-semibold text-green-900 shadow-lg hover:bg-green-50 dark:border-gray-700 dark:bg-gray-900 dark:text-green-200 dark:hover:bg-gray-800">Moje oferty</a>}
          </div>
        )}

        {isPickingLocation && (
          <div className="absolute left-1/2 top-16 z-[1000] flex w-[min(92vw,390px)] -translate-x-1/2 items-center justify-between gap-3 rounded-xl border border-green-200 bg-white/95 px-4 py-3 text-sm text-green-950 shadow-lg backdrop-blur dark:border-green-800 dark:bg-gray-900/95 dark:text-green-100">
            <span>Wskaż miejsce skarbu, klikając mapę.</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 px-2 text-gray-600 dark:text-gray-300"
              onClick={() => { pickingLocationRef.current = false; setIsPickingLocation(false); }}
            >
              Anuluj
            </Button>
          </div>
        )}

        {/* Address search (admin) — bottom-centered, responsive width */}
        {isAdmin && (
          <form
            onSubmit={handleAddressSearch}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[1000] bg-white/95 dark:bg-gray-800/95 backdrop-blur shadow-lg rounded-lg border border-green-100 dark:border-gray-600 p-2 flex items-center gap-2 w-[min(92vw,360px)]"
          >
            <Input
              placeholder="Szukaj ulicy w Szczecinie..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 text-sm border-none focus-visible:ring-1 focus-visible:ring-green-500"
            />
            <Button type="submit" size="icon" className="w-8 h-8 bg-green-700 hover:bg-green-800" disabled={searching}>
              {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            </Button>
          </form>
        )}

        {/* ── Guest floating controls (top-right) — theme toggle + logout.
            Admins have these in the sidebar header; guests have no sidebar. ── */}
        {!isAdmin && (
          <div className="absolute top-3 right-3 z-[1100] flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleTheme}
              title={theme === "dark" ? "Tryb jasny" : "Tryb ciemny"}
              className="w-10 h-10 bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-600 flex items-center justify-center active:scale-95 transition-transform"
            >
              {theme === "dark" ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-gray-600 dark:text-gray-300" />}
            </button>
            <button
              type="button"
              onClick={onLogout}
              title="Wyloguj"
              className="w-10 h-10 bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-600 flex items-center justify-center active:scale-95 transition-transform"
            >
              <LogOut className="w-4 h-4 text-red-500" />
            </button>
          </div>
        )}

        {/* ── Admin Side Panel (RIGHT) ──
            Desktop: fixed 320 px column on the right, always visible.
            Mobile: hidden by default; hamburger (top-right) slides it in from the right.
            No accordion — all sections are always expanded and readable at once.
        ── */}
        {isAdmin && (
          <>
            {/* Mobile backdrop */}
            {isMobile && !sidebarCollapsed && (
              <button
                type="button"
                aria-label="Zamknij panel"
                onClick={() => setSidebarCollapsed(true)}
                className="absolute inset-0 bg-black/30 z-[1040] animate-in fade-in duration-200"
              />
            )}

            <aside
              className={`
                absolute z-[1050] flex flex-col bg-[#fafbfc] shadow-xl dark:bg-gray-900
                overflow-hidden border-gray-200 dark:border-gray-700
                transition-transform duration-300 ease-in-out
                ${isMobile
                  ? `inset-x-0 bottom-0 top-auto h-[min(78dvh,680px)] rounded-t-2xl border-t ${sidebarCollapsed ? "translate-y-[calc(100%-4.25rem)]" : "translate-y-0"}`
                  : "right-0 top-0 bottom-0 border-l translate-y-0"}
              `}
              style={{ width: isMobile ? "100%" : "clamp(360px, 30vw, 420px)" }}
            >
              {isMobile && (
                <button
                  type="button"
                  aria-expanded={!sidebarCollapsed}
                  aria-label={sidebarCollapsed ? "Rozwiń panel skarbów" : "Zwiń panel skarbów"}
                  onClick={() => setSidebarCollapsed((v) => !v)}
                  className="flex h-9 shrink-0 items-center justify-center gap-2 border-b border-gray-200 bg-white text-xs font-semibold text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
                >
                  <span className="h-1 w-10 rounded-full bg-gray-300 dark:bg-gray-600" />
                  Skarby ({filteredMarkers.length})
                  {sidebarCollapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
              )}
              {/* ── Header ── */}
              <div className="px-4 h-12 flex items-center justify-between border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Shield className="w-4 h-4 text-green-700 dark:text-green-400 shrink-0" />
                  <span className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">
                    {user?.name ?? "admin"}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onToggleTheme}
                    title={theme === "dark" ? "Tryb jasny" : "Tryb ciemny"}
                    className="h-8 w-8 text-gray-500 dark:text-gray-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-gray-700"
                  >
                    {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                  </Button>
                  {user?.canAccessAnalytics && (
                    <a href="/analytics" className="rounded-md px-2 py-1.5 text-xs font-semibold text-green-800 hover:bg-green-50 dark:text-green-300 dark:hover:bg-gray-700">Analityka</a>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onLogout}
                    className="h-8 px-2 text-red-600 hover:text-red-700 hover:bg-red-50 shrink-0"
                  >
                    <LogOut className="w-3.5 h-3.5 mr-1" />
                    <span className="text-xs">Wyloguj</span>
                  </Button>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">

                {user && !layoutPreview && (hasUnlimitedPins || isCreator) && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
                    {hasUnlimitedPins ? (
                      <>Pinezki: <strong>bez limitu</strong></>
                    ) : isCreator ? (
                      <>
                        <div>Pozostałe pinezki: <strong>{pinBalance ?? "…"}</strong></div>
                        <span className="mt-1 block text-xs">1 pinezka = 1 aktywny skarb na mapie. Zakup jest jednorazowy i nie odnawia się automatycznie.</span>
                        {!firstPurchaseBonusGranted && <span className="mt-1 block text-xs font-semibold">Przy pierwszym zakupie otrzymasz dodatkowe {FIRST_PURCHASE_BONUS_PINS} pinezek.</span>}
                        {paymentPending && <p role="status" className="mt-2 text-xs font-medium">Potwierdzamy płatność. Saldo odświeży się automatycznie.</p>}
                        {checkoutError && <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">{checkoutError}</p>}
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          {CREATOR_PIN_PACKAGES.map((pack) => (
                            <div key={pack.id} className="rounded-lg border border-amber-200 bg-white p-2 dark:border-amber-800 dark:bg-gray-900">
                              <div className="min-h-8 text-[10px] font-semibold text-green-800 dark:text-green-300">{pack.badge ?? "Pakiet jednorazowy"}</div>
                              <div className="font-bold">{pack.name} · {pack.pins}</div>
                              <div className="mb-2 text-xs">pinezek · {(pack.amountCents / 100).toLocaleString("pl-PL")} zł</div>
                              <Button type="button" size="sm" className="h-8 w-full bg-green-700 hover:bg-green-800" disabled={checkoutBusy !== null} onClick={() => void handlePinCheckout(pack.id)}>
                                {checkoutBusy === pack.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Kup jednorazowo"}
                              </Button>
                            </div>
                          ))}
                        </div>
                        <a href="/cennik.html" className="mt-2 inline-block text-xs font-medium text-green-800 underline dark:text-green-300">Szczegółowy cennik dla Kreatorów</a>
                      </>
                    ) : null}
                  </div>
                )}

                {canManageAccounts && !layoutPreview && (
                  <details className="rounded-xl border border-green-200 bg-white p-3 dark:border-green-900 dark:bg-gray-800">
                    <summary className="cursor-pointer font-semibold text-green-950 dark:text-green-100">
                      {user?.role === "master_admin" ? "Panel główny · konta i statystyki" : "Konta Kreatorów"}
                    </summary>
                    <form onSubmit={handleCreateManagedAccount} className="mt-3 space-y-2">
                      <label className="block text-xs font-medium">Login
                        <Input required minLength={3} maxLength={32} value={accountName} onChange={(event) => setAccountName(event.target.value)} className="mt-1 h-9" autoComplete="off" />
                      </label>
                      {user?.role === "master_admin" && (
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
                          <div><strong>{globalOverview.activatedMarkers}</strong><span className="block text-gray-600 dark:text-gray-300">Rozpoczęte gry</span></div>
                          <div><strong>{globalOverview.activeMarkers}</strong><span className="block text-gray-600 dark:text-gray-300">Aktywne skarby</span></div>
                      <div><strong>{globalOverview.totalRedemptions}</strong><span className="block text-gray-600 dark:text-gray-300">Użycia tokenów</span></div>
                        </div>
                        <div className="mt-3 border-t border-green-200 pt-2 dark:border-green-900">
                          <strong>Statystyki wszystkich Kreatorów</strong>
                          <div className="mt-2 space-y-1.5">
                            {globalOverview.creatorUsage.map((creator) => (
                              <div key={creator.id} className="flex items-center justify-between gap-2 rounded-md bg-white px-2 py-1.5 dark:bg-gray-900">
                                <span className="min-w-0 truncate font-semibold text-green-800 dark:text-green-300">{creator.name}</span>
                                <span className="shrink-0 text-right text-[10px] text-gray-600 dark:text-gray-300">{creator.markers} skarbów · {creator.activations} rozpoczętych gier · {creator.redemptions} użyć tokenów</span>
                              </div>
                            ))}
                            {globalOverview.creatorUsage.length === 0 && <p className="text-gray-600 dark:text-gray-300">Nie ma jeszcze kont Kreatorów.</p>}
                          </div>
                        </div>
                      </div>
                    )}
                    <div className="mt-4 space-y-2 border-t pt-3">
                      {managedUsers.map((managed) => (
                        <div key={managed.id} className="rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-gray-900">
                          <div className="flex items-center justify-between gap-2 font-semibold">
                            <span>{managed.name} <span className="font-normal text-gray-500">· {accountRoleLabel(managed.role)}</span></span>
                            <span>{managed.role === "master_admin" || managed.role === "moderator" ? "Bez limitu pinezek" : `${managed.pinBalance} pinezek`}</span>
                          </div>
                          <div className="mt-1 text-gray-600 dark:text-gray-300">{managed.totalPins} skarbów · {managed.discoveries} rozpoczętych gier · {managed.redemptions} użyć tokenów</div>
                          {managed.role === "admin" && (
                            <>
                              <Button type="button" variant="outline" size="sm" className="mt-2 h-8 w-full" disabled={inviteBusyId === managed.id} onClick={() => void handleReissueInvite(managed.id, managed.name)}>
                                {inviteBusyId === managed.id ? "Tworzenie linku…" : "Utwórz nowe zaproszenie"}
                              </Button>
                            </>
                          )}
                          {user?.role === "master_admin" && managed.role !== "master_admin" && (
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
                            <div className="font-semibold">{auditEventLabel(event.eventType)}</div>
                            <div className="text-gray-600 dark:text-gray-300">{auditActorLabel(event)}{event.details.username ? ` · ${event.details.username}` : ""} · {new Date(event.createdAt).toLocaleString("pl-PL")}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </details>
                )}

                {/* ── Combined: STATYSTYKI & ODKRYCIA (collapsible) ── */}
                <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm">
                  {/* Section title — click anywhere on header to collapse */}
                  <button
                    type="button"
                    onClick={toggleStats}
                    className="w-full px-4 pt-3 pb-2 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between gap-2 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-t-xl transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <BarChart3 className="w-4 h-4 text-green-700 dark:text-green-400" />
                      <span className="text-xs font-bold tracking-wider text-gray-800 dark:text-gray-200 uppercase">
                        Statystyki &amp; Odkrycia
                      </span>
                      {/* Compact summary visible when collapsed */}
                      {!statsOpen && stats && discoveries && (
                        <span className="text-[10px] text-gray-400 dark:text-gray-500 font-normal ml-1">
                          {stats.activeMarkers}A / {stats.expiredMarkers}W · {discoveries.count} odkryć
                        </span>
                      )}
                    </div>
                    {statsOpen
                      ? <ChevronUp className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 shrink-0" />
                      : <ChevronDown className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 shrink-0" />
                    }
                  </button>

                  {statsOpen && (
                    <div className="px-4 py-3 flex flex-col gap-3">
                      {/* Stat tiles */}
                      {stats && (
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setStatsFilter((f) => (f === "active" ? "all" : "active"))}
                            className={`bg-white dark:bg-gray-700 border rounded-xl px-3 py-2.5 text-left transition-all flex flex-col gap-0.5 ${
                              statsFilter === "active"
                                ? "ring-2 ring-green-500 border-green-300 dark:border-green-600"
                                : "border-gray-200 dark:border-gray-600 hover:border-green-300"
                            }`}
                          >
                            <span className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                              Aktywne
                            </span>
                            <span className="font-bold text-2xl text-gray-900 dark:text-gray-100 leading-tight">
                              {stats.activeMarkers}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setStatsFilter((f) => (f === "expired" ? "all" : "expired"))}
                            className={`bg-white dark:bg-gray-700 border rounded-xl px-3 py-2.5 text-left transition-all flex flex-col gap-0.5 ${
                              statsFilter === "expired"
                                ? "ring-2 ring-red-400 border-red-200 dark:border-red-700"
                                : "border-gray-200 dark:border-gray-600 hover:border-red-200"
                            }`}
                          >
                            <span className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                              Wygasłe
                            </span>
                            <span className="font-bold text-2xl text-gray-900 dark:text-gray-100 leading-tight">
                              {stats.expiredMarkers}
                            </span>
                          </button>
                        </div>
                      )}
                      {statsFilter !== "all" && (
                        <button
                          type="button"
                          onClick={() => setStatsFilter("all")}
                          className="text-[11px] text-green-700 dark:text-green-400 hover:underline self-start -mt-1"
                        >
                          Wyczyść filtr
                        </button>
                      )}

                      {/* Divider */}
                      <div className="border-t border-gray-100 dark:border-gray-700" />

                      {/* Odkrycia data */}
                      {discoveries && (
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center gap-2">
                            <Compass className="w-3.5 h-3.5 text-green-700 dark:text-green-400 shrink-0" />
                            <span className="text-xs font-bold tracking-wider text-gray-700 dark:text-gray-300 uppercase">Odkrycia</span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-[12px]">
                            <div className="bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2">
                              <div className="text-gray-500 dark:text-gray-400 text-[10px] mb-0.5">Ostatni reset</div>
                              <div className="font-mono font-semibold text-gray-900 dark:text-gray-100">
                                {formatShortDate(discoveries.lastResetAt)}
                              </div>
                            </div>
                            <div className="bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2">
                              <div className="text-gray-500 dark:text-gray-400 text-[10px] mb-0.5">Od resetu</div>
                              <div className="font-mono font-bold text-2xl text-gray-900 dark:text-gray-100 leading-tight">
                                {discoveries.count}
                              </div>
                            </div>
                          </div>

                          {user?.role === "master_admin" && <Button
                            type="button"
                            size="sm"
                            onClick={handleResetDiscoveries}
                            disabled={resetDiscoveries.isPending}
                            className="h-8 w-full text-[12px] font-semibold bg-amber-400 hover:bg-amber-500 text-amber-950 border-0"
                          >
                            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                            Resetuj licznik odkryć
                          </Button>}

                          {/* Recent activations log — code + time + street name */}
                          <div>
                            <div className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
                              Ostatnie odkrycia ({discoveries.recent.length})
                            </div>
                            {discoveries.recent.length === 0 ? (
                              <div className="text-[11px] italic text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2">
                                Nie rozpoczęto jeszcze żadnej gry od ostatniego wyczyszczenia historii.
                              </div>
                            ) : (
                              <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-900 rounded-lg px-3 py-2 font-mono text-[11px] leading-relaxed space-y-1 text-yellow-900 dark:text-yellow-200">
                                {discoveries.recent.map((r) => (
                                  <div key={`${r.code}-${r.activatedAt}`}>
                                    <span className="text-yellow-600 dark:text-yellow-400">({formatLogTime(r.activatedAt)})</span>
                                    {" — "}{r.code}
                                    {" — "}
                                    <span className="text-yellow-700 dark:text-yellow-300 italic">
                                      {streetLabels[r.code] ?? "…"}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>

                {/* ── SKARBY list ── */}
                <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm">
                  <div className="px-4 pt-3 pb-2 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-green-700 dark:text-green-400" />
                      <span className="text-xs font-bold tracking-wider text-gray-800 dark:text-gray-200 uppercase">
                        Skarby ({filteredMarkers.length}
                        {statsFilter !== "all" ? `/${markers.length}` : ""})
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {saved && (
                        <span className="text-[10px] font-bold text-green-600 dark:text-green-400">✓ Zapisano</span>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        onClick={startLocationSelection}
                        className="h-8 px-2 text-xs font-semibold bg-green-700 text-white hover:bg-green-800"
                        title="Dodaj skarb"
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" />
                        Dodaj
                      </Button>
                      <button
                        type="button"
                        onClick={() => queryClient.invalidateQueries({ queryKey: getListMarkersQueryKey() })}
                        className="w-7 h-7 inline-flex items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                        title="Odśwież"
                      >
                        <RefreshCcw className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 p-3">
                    <div className="flex gap-2">
                      <div className="relative min-w-0 flex-1">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                        <Input
                          value={markerSearch}
                          onChange={(e) => setMarkerSearch(e.target.value)}
                          placeholder="Szukaj skarbów"
                          aria-label="Szukaj skarbów po nazwie lub tokenie"
                          className="h-10 rounded-lg bg-gray-50 pl-9 text-sm dark:bg-gray-700"
                        />
                        {markerSearch && (
                          <button
                            type="button"
                            onClick={() => setMarkerSearch("")}
                            aria-label="Wyczyść wyszukiwanie"
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                      <select
                        aria-label="Sortuj skarby"
                        value={markerSort}
                        onChange={(e) => setMarkerSort(e.target.value as "newest" | "name")}
                        className="h-10 max-w-[112px] rounded-lg border border-gray-200 bg-gray-50 px-2 text-xs text-gray-700 outline-none focus-visible:ring-2 focus-visible:ring-green-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                      >
                        <option value="newest">Najnowsze</option>
                        <option value="name">Nazwa A–Z</option>
                      </select>
                    </div>
                    {filteredMarkers.map((m) => (
                      <MarkerRow
                        key={m.id}
                        m={m}
                        onFly={flyToMarker}
                        onDelete={handleDeleteMarker}
                        onCopy={handleCopyCode}
                        onPreview={setPreviewMarker}
                        isSelected={selectedMarkerId === m.id}
                      />
                    ))}
                    {filteredMarkers.length === 0 && (
                      <div className="text-center p-4 text-gray-500 dark:text-gray-400 text-sm">
                        {markers.length === 0
                          ? "Brak skarbów. Wybierz „Dodaj skarb”, aby rozpocząć."
                          : markerSearch.trim()
                            ? "Nie znaleziono skarbów dla tego wyszukiwania."
                            : "Brak skarbów pasujących do filtra."}
                      </div>
                    )}
                  </div>
                </section>

              </div>
            </aside>
          </>
        )}

        {/* ── Admin login welcome notification (bottom-center, 3 s auto-dismiss) ── */}
        {loginMsg && (
          <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-[2000] pointer-events-none animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="px-5 py-2.5 rounded-2xl bg-white/90 dark:bg-gray-800/90 backdrop-blur shadow-lg border border-green-100 dark:border-green-900 text-[13px] font-medium text-green-900 dark:text-green-300 whitespace-nowrap">
              {loginMsg}
            </div>
          </div>
        )}

        {/* Guest: code expiry mm:ss countdown (bottom-center, visible on map).
            Per spec, the same red mm:ss timer that admins see for the code must
            also be visible to the user/guest. */}
        {guestData && (() => {
          const codeExpiresMs = new Date(guestData.markerExpiresAt).getTime();
          const codeRemaining = codeExpiresMs - guestNow;
          const codeExpired = codeRemaining <= 0;
          return (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[999] pointer-events-none">
              {/* Minimalist guest timer: just a clock icon + mm:ss. No "Pozostało:" label. */}
              <div className={`px-4 py-2 rounded-full text-sm font-mono font-bold shadow-lg flex items-center gap-2 border ${
                codeExpired
                  ? "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-600"
                  : "bg-white/90 dark:bg-gray-800/90 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800"
              }`}>
                <Clock className="w-4 h-4" />
                {codeExpired ? "00:00" : formatCodeTimer(codeRemaining)}
              </div>
            </div>
          );
        })()}
      </div>

      {/* ── Admin Create Sheet ── */}
      <Sheet open={isSheetOpen} onOpenChange={setIsSheetOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto sm:max-w-md sm:mx-auto rounded-t-xl">
          <SheetHeader>
                        <SheetTitle>Dodaj nowy skarb</SheetTitle>
            <SheetDescription>
              Wprowadź dane skarbu. Token zostanie wygenerowany automatycznie i skopiowany do schowka.
            </SheetDescription>
          </SheetHeader>
          <form onSubmit={handleCreateMarker} className="mt-4 space-y-4">
            {clickPos && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200">
                <span>Miejsce wybrane na mapie</span>
                <button
                  type="button"
                  className="font-semibold underline underline-offset-2"
                  onClick={() => { setIsSheetOpen(false); startLocationSelection(); }}
                >
                  Zmień miejsce
                </button>
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">Nazwa</label>
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                required
                placeholder="np. Złoty Graal na Wałach"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Wskazówka (opis)</label>
              <Textarea
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                required
                placeholder="Idź wzdłuż rzeki aż zobaczysz..."
                className="resize-none"
              />
            </div>

            {/* Optional image settings stay closed until the creator needs them. */}
            <details className="rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700">
              <summary className="cursor-pointer text-sm font-medium">Dodaj zdjęcie (opcjonalnie)</summary>
              <div className="mt-3 space-y-2">

              {/* Hidden file input — triggered by both "Wybierz" and "Zmień" buttons */}
              <input
                id="img-upload"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleImageUpload}
              />

              {newImg ? (
                /* Preview + replace/remove controls */
                <div className="space-y-2">
                  <div className="rounded-md overflow-hidden h-32 relative border border-gray-200">
                    <img src={newImg} alt="Preview" className="object-cover w-full h-full" />
                    {imgProcessing && (
                      <div className="absolute inset-0 bg-white/70 flex items-center justify-center">
                        <Loader2 className="w-6 h-6 animate-spin text-green-600" />
                      </div>
                    )}
                    {/* Brief green-check confirmation after a successful upload. */}
                    {imgUploadedFlash && !imgProcessing && (
                      <div className="absolute top-1 right-1 bg-green-600 text-white rounded-full p-1 shadow animate-in fade-in zoom-in duration-200">
                        <Check className="w-4 h-4" />
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => document.getElementById("img-upload")?.click()}
                      disabled={imgProcessing}
                    >
                      <ImageIcon className="w-3 h-3 mr-1" />
                      Zmień zdjęcie
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1 text-red-600 hover:bg-red-50 hover:text-red-700 border-red-200"
                      onClick={() => setNewImg(null)}
                      disabled={imgProcessing}
                    >
                      <X className="w-3 h-3 mr-1" />
                      Usuń zdjęcie
                    </Button>
                  </div>
                </div>
              ) : (
                /* No image yet — show single upload button */
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => document.getElementById("img-upload")?.click()}
                  disabled={imgProcessing}
                >
                  {imgProcessing ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Kompresja…</>
                  ) : imgUploadedFlash ? (
                    <><Check className="w-4 h-4 mr-2 text-green-600" /> Wgrane</>
                  ) : (
                    <><ImageIcon className="w-4 h-4 mr-2" /> Wybierz zdjęcie</>
                  )}
                </Button>
              )}
                <p className="text-xs text-gray-400">Zdjęcia są automatycznie kompresowane do maks. 1 MB.</p>
              </div>
            </details>

            <Button
              type="submit"
              className="w-full bg-green-600 hover:bg-green-700"
              disabled={createMarker.isPending || !newTitle || !newDesc || imgProcessing}
            >
              {createMarker.isPending ? "Zapisywanie..." : "Ukryj skarb"}
            </Button>
          </form>
        </SheetContent>
      </Sheet>

      {/* ── Image Preview Modal (admin: view any marker's image) ── */}
      <Dialog open={!!previewMarker} onOpenChange={(open) => !open && setPreviewMarker(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-green-900">{previewMarker?.title}</DialogTitle>
          </DialogHeader>
          {previewMarker && safePopupImageUrl(previewMarker.imageUrl ?? null) ? (
            <div className="rounded-md overflow-hidden border">
              <img
                src={safePopupImageUrl(previewMarker.imageUrl ?? null) ?? undefined}
                alt={previewMarker.title}
                className="w-full object-contain max-h-72"
              />
            </div>
          ) : (
            <div className="h-32 flex items-center justify-center bg-gray-50 text-gray-400 text-sm italic border rounded-md">
              No image available
            </div>
          )}
          <p className="text-xs text-gray-500 italic">{previewMarker?.description}</p>
        </DialogContent>
      </Dialog>

      <Dialog open={pinPurchaseOpen} onOpenChange={setPinPurchaseOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-green-900 dark:text-green-200">Pakiety pinezek dla Kreatorów</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600 dark:text-gray-300">1 pinezka = 1 aktywny skarb na mapie. Każdy zakup jest jednorazowy. {!firstPurchaseBonusGranted && `Przy pierwszym zakupie otrzymasz dodatkowe ${FIRST_PURCHASE_BONUS_PINS} pinezek.`}</p>
          {checkoutError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{checkoutError}</p>}
          <div className="grid grid-cols-2 gap-2">
            {CREATOR_PIN_PACKAGES.map((pack) => (
              <div key={pack.id} className="rounded-lg border border-green-200 p-2 text-sm dark:border-green-900">
                <div className="min-h-8 text-[10px] font-semibold text-green-800 dark:text-green-300">{pack.badge ?? "Pakiet jednorazowy"}</div>
                <strong>{pack.name}</strong><div>{pack.pins} pinezek · {(pack.amountCents / 100).toLocaleString("pl-PL")} zł</div>
                <Button type="button" size="sm" className="mt-2 w-full bg-green-700" disabled={checkoutBusy !== null} onClick={() => void handlePinCheckout(pack.id)}>{checkoutBusy === pack.id ? "Przekierowanie…" : "Kup"}</Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

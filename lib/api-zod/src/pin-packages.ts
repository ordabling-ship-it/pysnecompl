import { CREATOR_PIN_PACKAGES } from "./pin-packages.mjs";

export const PIN_PACKAGES = CREATOR_PIN_PACKAGES.map((pack) => ({
  id: pack.id,
  name: pack.name,
  pins: pack.pins,
  pricePln: pack.amountCents / 100,
  badge: pack.badge,
}));

export type PinPackageId = (typeof PIN_PACKAGES)[number]["id"];

export const USER_ROLES = ["master_admin", "moderator", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export function getRoleCapabilities(role: string) {
  return {
    canManageCreators: role === "master_admin" || role === "moderator",
    canCreateModerators: role === "master_admin",
    hasUnlimitedPins: role === "master_admin" || role === "moderator",
    canViewGlobalPinStats: role === "master_admin" || role === "moderator",
  };
}

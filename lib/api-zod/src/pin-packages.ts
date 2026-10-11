export const PIN_PACKAGES = [
  { id: "small", name: "Mały", pins: 50, pricePln: 249 },
  { id: "medium", name: "Średni", pins: 100, pricePln: 449 },
  { id: "large", name: "Duży", pins: 250, pricePln: 849 },
] as const;

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

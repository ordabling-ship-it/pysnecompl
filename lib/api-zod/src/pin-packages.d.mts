export type CreatorPinPackageId = "start" | "growth" | "popular" | "event";

export type CreatorPinPackage = Readonly<{
  id: CreatorPinPackageId;
  name: string;
  pins: number;
  amountCents: number;
  badge?: string;
}>;

export const CREATOR_PIN_PACKAGES: readonly CreatorPinPackage[];
export const FIRST_PURCHASE_BONUS_PINS: 5;
export function getCreatorPinPackage(packageId: unknown): CreatorPinPackage | null;

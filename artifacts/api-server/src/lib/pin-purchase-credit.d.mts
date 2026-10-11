export type PendingPinPurchase = {
  id: number;
  creatorUserId: number;
  pins: number;
};

export type PinCreditResult = {
  creatorUserId: number;
  pins: number;
  bonusPins: number;
  addedPins: number;
};

export function creditPendingPurchaseOnce(input: {
  purchaseId: number;
  firstPurchaseBonusPins: number;
  markPaidIfPending: (purchaseId: number) => Promise<PendingPinPurchase | null>;
  lockCreator: (creatorUserId: number) => Promise<{ id: number; firstPurchaseBonusGranted: boolean } | null>;
  addPins: (creatorUserId: number, pins: number) => Promise<unknown>;
  markFirstPurchaseBonusGranted: (creatorUserId: number) => Promise<unknown>;
  saveBonusPins: (purchaseId: number, bonusPins: number) => Promise<unknown>;
}): Promise<PinCreditResult | null>;

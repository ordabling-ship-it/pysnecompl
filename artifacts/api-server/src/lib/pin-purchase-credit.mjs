/**
 * Credits a purchase only after the repository atomically claims its pending
 * state. All callbacks run inside the caller's database transaction.
 */
export async function creditPendingPurchaseOnce({
  purchaseId,
  firstPurchaseBonusPins,
  markPaidIfPending,
  lockCreator,
  addPins,
  markFirstPurchaseBonusGranted,
  saveBonusPins,
}) {
  const purchase = await markPaidIfPending(purchaseId);
  if (!purchase) return null;

  const creator = await lockCreator(purchase.creatorUserId);
  if (!creator) throw new Error("The creator for a paid pin purchase no longer exists.");

  const bonusPins = creator.firstPurchaseBonusGranted ? 0 : firstPurchaseBonusPins;
  const addedPins = purchase.pins + bonusPins;
  await addPins(creator.id, addedPins);
  if (bonusPins > 0) await markFirstPurchaseBonusGranted(creator.id);
  await saveBonusPins(purchase.id, bonusPins);

  return { creatorUserId: creator.id, pins: purchase.pins, bonusPins, addedPins };
}

export const CREATOR_PIN_PACKAGES = Object.freeze([
  Object.freeze({ id: "start", name: "Start", pins: 20, amountCents: 9_900 }),
  Object.freeze({ id: "growth", name: "Rozwój", pins: 50, amountCents: 19_900 }),
  Object.freeze({ id: "popular", name: "Popularny", pins: 100, amountCents: 29_900, badge: "Najczęściej wybierany" }),
  Object.freeze({ id: "event", name: "Event", pins: 250, amountCents: 59_900, badge: "Najlepsza cena za pinezkę" }),
]);

export const FIRST_PURCHASE_BONUS_PINS = 5;

export function getCreatorPinPackage(packageId) {
  if (typeof packageId !== "string") return null;
  return CREATOR_PIN_PACKAGES.find((pinPackage) => pinPackage.id === packageId) ?? null;
}

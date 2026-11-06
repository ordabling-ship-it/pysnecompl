import { CREATOR_PIN_PACKAGES, FIRST_PURCHASE_BONUS_PINS, type CreatorPinPackageId } from "@workspace/api-zod/pin-packages";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type PinPackagesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  firstPurchaseBonusGranted: boolean;
  checkoutBusy: CreatorPinPackageId | null;
  checkoutError: string | null;
  onCheckout: (packageId: CreatorPinPackageId) => void;
};

export default function PinPackagesDialog({
  open,
  onOpenChange,
  firstPurchaseBonusGranted,
  checkoutBusy,
  checkoutError,
  onCheckout,
}: PinPackagesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-green-900 dark:text-green-200">Pakiety pinezek dla Kreatorów</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          1 pinezka = 1 skarb na mapie albo 1 opublikowana gra. Każdy zakup jest jednorazowy.
          {!firstPurchaseBonusGranted && ` Przy pierwszym zakupie otrzymasz dodatkowe ${FIRST_PURCHASE_BONUS_PINS} pinezek.`}
        </p>
        {checkoutError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{checkoutError}</p>}
        <div className="grid grid-cols-2 gap-2">
          {CREATOR_PIN_PACKAGES.map((pack) => (
            <div key={pack.id} className="rounded-lg border border-green-200 p-2 text-sm dark:border-green-900">
              <div className="min-h-8 text-[10px] font-semibold text-green-800 dark:text-green-300">{pack.badge ?? "Pakiet jednorazowy"}</div>
              <strong>{pack.name}</strong>
              <div>{pack.pins} pinezek · {(pack.amountCents / 100).toLocaleString("pl-PL")} zł</div>
              <Button type="button" size="sm" className="mt-2 w-full bg-green-700" disabled={checkoutBusy !== null} onClick={() => onCheckout(pack.id)}>
                {checkoutBusy === pack.id ? "Przekierowanie…" : "Kup"}
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

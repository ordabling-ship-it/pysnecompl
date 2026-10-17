export function normalizeCoordinates(lat: unknown, lng: unknown, precision?: number): { lat: number; lng: number } | null;
export function toPriceCents(pricePln: unknown): number | null;
export function generatePickupCode(): string;
export function hashPickupCode(code: string): string;
export function matchesPickupCode(code: string, expectedHash: string): boolean;
export function canRespondToReservation(status: string, action: string): boolean;
export function canCancelReservation(status: string): boolean;
export function canConfirmPickup(status: string, expiresAt: string | Date | null, now?: number): boolean;
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number | null;

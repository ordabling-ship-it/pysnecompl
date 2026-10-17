import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function normalizeCoordinates(lat, lng, precision = 5) {
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  return { lat: Number(lat.toFixed(precision)), lng: Number(lng.toFixed(precision)) };
}

export function toPriceCents(pricePln) {
  if (typeof pricePln !== "number" || !Number.isFinite(pricePln) || pricePln < 0 || pricePln > 1_000_000) return null;
  return Math.round(pricePln * 100);
}

export function generatePickupCode() {
  return String(randomBytes(4).readUInt32BE(0) % 100_000_000).padStart(8, "0");
}

export function hashPickupCode(code) {
  return createHash("sha256").update(code).digest("hex");
}

export function matchesPickupCode(code, expectedHash) {
  if (!/^\d{8}$/.test(code) || typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  return timingSafeEqual(Buffer.from(hashPickupCode(code), "hex"), Buffer.from(expectedHash, "hex"));
}

export function canRespondToReservation(status, action) {
  return status === "requested" && (action === "accept" || action === "reject");
}

export function canCancelReservation(status) {
  return status === "requested" || status === "accepted";
}

export function canConfirmPickup(status, expiresAt, now = Date.now()) {
  return status === "accepted" && Number.isFinite(new Date(expiresAt).getTime()) && new Date(expiresAt).getTime() > now;
}

export function haversineKm(aLat, aLng, bLat, bLng) {
  const points = [normalizeCoordinates(aLat, aLng), normalizeCoordinates(bLat, bLng)];
  if (points.some((point) => point === null)) return null;
  const [a, b] = points;
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const term = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(term), Math.sqrt(1 - term));
}

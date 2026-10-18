import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

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
  return status === "requested" || status === "accepted" || status === "pickup_ready";
}

export function canConfirmPickup(status, expiresAt, now = Date.now()) {
  return (status === "pickup_ready" || status === "paid") && Number.isFinite(new Date(expiresAt).getTime()) && new Date(expiresAt).getTime() > now;
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

export function calculatePlatformFee(grossAmountCents) {
  if (!Number.isSafeInteger(grossAmountCents) || grossAmountCents < 0) return null;
  const variableFee = Math.round(grossAmountCents * 0.05);
  const fee = 123 + variableFee;
  return { grossAmountCents, platformFeeCents: fee, creatorNetCents: Math.max(0, grossAmountCents - fee) };
}

function encryptionKey(secret) {
  return createHash("sha256").update(String(secret || "")).digest();
}

export function encryptPickupCode(code, secret) {
  if (!/^\d{8}$/.test(code) || !secret) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptPickupCode(ciphertext, secret) {
  if (typeof ciphertext !== "string" || !secret) return null;
  const [ivEncoded, tagEncoded, valueEncoded] = ciphertext.split(".");
  if (!ivEncoded || !tagEncoded || !valueEncoded) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(ivEncoded, "base64url"));
    decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
    const value = Buffer.concat([decipher.update(Buffer.from(valueEncoded, "base64url")), decipher.final()]).toString("utf8");
    return /^\d{8}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

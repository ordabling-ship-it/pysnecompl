import { randomInt } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function genCode(): string {
  return Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const SCRYPT_PREFIX = "scrypt-v1";

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export function isPasswordHash(value: string): boolean {
  return value.startsWith(`${SCRYPT_PREFIX}$`);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return `${SCRYPT_PREFIX}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [version, saltValue, keyValue, extra] = encoded.split("$");
  if (version !== SCRYPT_PREFIX || !saltValue || !keyValue || extra !== undefined) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltValue, "base64url");
    expected = Buffer.from(keyValue, "base64url");
  } catch {
    return false;
  }
  if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;

  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, expected);
}

import crypto from "node:crypto";

/**
 * AES-256-GCM encryption for sensitive fields (routing/account numbers, EIN).
 *
 * The key is read from the ENCRYPTION_KEY env var (32-byte hex or base64). If
 * absent, a deterministic development key is derived so the demo still runs —
 * this is logged as a warning on boot. Production MUST set ENCRYPTION_KEY via a
 * managed secret store; never commit a real key.
 */

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const env = process.env.ENCRYPTION_KEY;
  if (env) {
    // accept hex or base64
    if (/^[0-9a-fA-F]{64}$/.test(env)) return Buffer.from(env, "hex");
    try {
      const b = Buffer.from(env, "base64");
      if (b.length === 32) return b;
    } catch {
      /* fall through */
    }
  }
  /* No usable key. In production, refuse to boot rather than silently encrypting
     bank data under a publicly known constant — and note that decrypt() returns
     null on mismatch, so a wrong key would quietly blank routing numbers instead
     of raising. */
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "ENCRYPTION_KEY must be set to 32 bytes (64 hex chars or base64) in production. " +
        "Generate one with: openssl rand -hex 32"
    );
  }
  // dev fallback — derived from a fixed seed. NOT for production.
  return crypto.createHash("sha256").update("checkwriter-dev-key-change-me").digest();
}

export function encrypt(plain: string | null | undefined): string | null {
  if (plain == null || plain === "") return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: iv:tag:ciphertext  (all base64)
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decrypt(ciphertext: string | null | undefined): string | null {
  if (!ciphertext) return null;
  try {
    const [ivB64, tagB64, dataB64] = ciphertext.split(":");
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const data = Buffer.from(dataB64, "base64");
    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}

export function last4Of(account: string | null | undefined): string | null {
  if (!account) return null;
  const digits = account.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Hash a password with scrypt. Returns "salt:hash" (both base64). */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return [salt.toString("base64"), hash.toString("base64")].join(":");
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [saltB64, hashB64] = stored.split(":");
    if (!saltB64 || !hashB64) return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const hash = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

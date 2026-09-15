// Agent context note: Encrypts individual retained-cache fields before SQLite using a cache-only HKDF domain. Keep nonces unique, tags explicit, envelopes strict, and AAD bound to field plus stable row id.
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { SafeWhatsAppError } from "../errors.js";

const MAX_PLAINTEXT_BYTES = 16 * 1_048_576;
const MAX_ENVELOPE_CHARS = 24 * 1_048_576;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const INFO = Buffer.from("safe-whatsapp-mcp/cache-encryption/v1", "utf8");

interface CacheEnvelope {
  v: 1;
  alg: "A256GCM";
  kv: 1;
  n: string;
  c: string;
  t: string;
}

export class CacheRecordCipher {
  private key: Buffer;
  private destroyed = false;

  constructor(masterKey: Uint8Array, vaultId: string) {
    if (masterKey.byteLength !== 32) throw invalidKey();
    const inputKey = Buffer.from(masterKey);
    try {
      this.key = Buffer.from(hkdfSync(
        "sha256",
        inputKey,
        Buffer.from(vaultId, "utf8"),
        INFO,
        32,
      ));
    } finally {
      inputKey.fill(0);
    }
  }

  encrypt(plaintext: string, aad: string): string {
    this.assertUsable();
    const bytes = Buffer.from(plaintext, "utf8");
    try {
      if (bytes.byteLength > MAX_PLAINTEXT_BYTES) throw recordTooLarge();
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", this.key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(aad, "utf8"), { plaintextLength: bytes.byteLength });
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const envelope: CacheEnvelope = {
        v: 1,
        alg: "A256GCM",
        kv: 1,
        n: nonce.toString("base64url"),
        c: ciphertext.toString("base64url"),
        t: cipher.getAuthTag().toString("base64url"),
      };
      return JSON.stringify(envelope);
    } finally {
      bytes.fill(0);
    }
  }

  decrypt(serialized: string, aad: string): string {
    this.assertUsable();
    try {
      const envelope = parseEnvelope(serialized);
      const nonce = decodeBase64Url(envelope.n, NONCE_BYTES);
      const ciphertext = decodeBase64Url(envelope.c);
      const tag = decodeBase64Url(envelope.t, TAG_BYTES);
      if (ciphertext.byteLength > MAX_PLAINTEXT_BYTES) throw invalidCiphertext();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        nonce,
        { authTagLength: TAG_BYTES },
      );
      decipher.setAAD(Buffer.from(aad, "utf8"), { plaintextLength: ciphertext.byteLength });
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      try {
        return plaintext.toString("utf8");
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw invalidCiphertext();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.key.fill(0);
    this.destroyed = true;
  }

  private assertUsable(): void {
    if (this.destroyed) {
      throw new SafeWhatsAppError(
        "WhatsApp cache encryption is unavailable.",
        "cache_cipher_unavailable",
      );
    }
  }
}

function parseEnvelope(serialized: string): CacheEnvelope {
  if (typeof serialized !== "string" || serialized.length < 1 ||
      serialized.length > MAX_ENVELOPE_CHARS) throw invalidCiphertext();
  const value = JSON.parse(serialized) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["alg", "c", "kv", "n", "t", "v"]) ||
      value.v !== 1 || value.alg !== "A256GCM" || value.kv !== 1 ||
      typeof value.n !== "string" || typeof value.c !== "string" || typeof value.t !== "string") {
    throw invalidCiphertext();
  }
  return value as unknown as CacheEnvelope;
}

function decodeBase64Url(value: string, exactBytes?: number): Buffer {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw invalidCiphertext();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value ||
      (exactBytes !== undefined && decoded.byteLength !== exactBytes)) throw invalidCiphertext();
  return decoded;
}

function invalidCiphertext(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "Encrypted WhatsApp cache data is invalid or could not be authenticated.",
    "cache_ciphertext_invalid",
  );
}

function invalidKey(): SafeWhatsAppError {
  return new SafeWhatsAppError("The cache-vault key is invalid.", "cache_key_invalid");
}

function recordTooLarge(): SafeWhatsAppError {
  return new SafeWhatsAppError("WhatsApp cache content is too large.", "cache_record_too_large");
}

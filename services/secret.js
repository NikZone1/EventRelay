
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { env } from "../config/env.js";

function getEncryptionKey() {
  const encodedKey = env.webhookEncryptionKey;

  if (!encodedKey) {
    throw new Error("WEBHOOK_ENCRYPTION_KEY is not configured");
  }

  const key = Buffer.from(encodedKey, "base64");

  if (key.length !== 32) {
    throw new Error(
      "WEBHOOK_ENCRYPTION_KEY must decode to exactly 32 bytes",
    );
  }

  return key;
}

export function encryptSecret(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("A non-empty webhook secret is required");
  }

  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Versioned format: v1:IV:AUTH_TAG:CIPHERTEXT
  return [
    "v1",
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(encryptedValue) {
  if (typeof encryptedValue !== "string") {
    throw new Error("Invalid encrypted webhook secret");
  }

  const [version, ivEncoded, tagEncoded, ciphertextEncoded, ...extra] =
    encryptedValue.split(":");

  if (
    version !== "v1" ||
    !ivEncoded ||
    !tagEncoded ||
    !ciphertextEncoded ||
    extra.length > 0
  ) {
    throw new Error("Invalid encrypted webhook secret format");
  }

  const iv = Buffer.from(ivEncoded, "base64");
  const authTag = Buffer.from(tagEncoded, "base64");
  const ciphertext = Buffer.from(ciphertextEncoded, "base64");

  if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) {
    throw new Error("Invalid encrypted webhook secret components");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    iv,
  );

  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

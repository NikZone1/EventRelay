
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret } from "../services/secret.js";

const original = `whsec_${randomBytes(32).toString("base64url")}`;

const encrypted = encryptSecret(original);
const decrypted = decryptSecret(encrypted);

if (encrypted === original) {
  throw new Error("Secret was not encrypted");
}

if (decrypted !== original) {
  throw new Error("Secret did not decrypt to its original value");
}

let tamperingDetected = false;

try {
  const parts = encrypted.split(":");
  parts[3] = Buffer.from("tampered-value").toString("base64");
  decryptSecret(parts.join(":"));
} catch {
  tamperingDetected = true;
}

if (!tamperingDetected) {
  throw new Error("Tampered ciphertext was not rejected");
}

console.log("PASS: Secret is encrypted");
console.log("PASS: Secret decrypts correctly");
console.log("PASS: Tampered ciphertext is rejected");


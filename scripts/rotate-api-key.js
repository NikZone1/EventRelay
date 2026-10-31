
import { randomBytes, createHash } from "node:crypto";
import { pool } from "../config/db.js";

const tenantId = "f1168379-1372-475d-b167-3c4329873f8e";
const rawKey = `er_live_${randomBytes(32).toString("base64url")}`;
const keyHash = createHash("sha256").update(rawKey).digest("hex");
const keyPrefix = rawKey.slice(0, 16);

const db = await pool.connect();

try {
  await db.query("BEGIN");

  // Development setup: revoke all active keys for this tenant.
  await db.query(
    `UPDATE api_keys
     SET revoked_at = NOW()
     WHERE tenant_id = $1 AND revoked_at IS NULL`,
    [tenantId],
  );

  await db.query(
    `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, "EventRelay E2E test key", keyPrefix, keyHash],
  );

  await db.query("COMMIT");

  console.log("Replacement API key (copy it now; it will not be stored in plaintext):");
  console.log(rawKey);
} catch (error) {
  await db.query("ROLLBACK");
  console.error("API key rotation failed:", error.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}

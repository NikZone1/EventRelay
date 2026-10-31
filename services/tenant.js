
import { createHash, randomBytes } from "node:crypto";
import { pool } from "../config/db.js";
import { createTenant } from "../models/tenant.js";
import { createApiKey } from "../models/apiKey.js";

export async function createTenantWithApiKey({
  tenantName,
  apiKeyName = "Default key",
}) {
  if (typeof tenantName !== "string" || !tenantName.trim()) {
    throw new Error("Tenant name is required");
  }

  if (typeof apiKeyName !== "string" || !apiKeyName.trim()) {
    throw new Error("API key name is required");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const tenant = await createTenant(client, tenantName.trim());

    // Generate a high-entropy credential.
    const rawApiKey = `er_live_${randomBytes(32).toString("base64url")}`;

    // Store only its SHA-256 hash.
    const keyHash = createHash("sha256")
      .update(rawApiKey)
      .digest("hex");

    const keyPrefix = rawApiKey.slice(0, 12);

    const apiKey = await createApiKey(client, {
      tenantId: tenant.id,
      name: apiKeyName.trim(),
      keyPrefix,
      keyHash,
    });

    await client.query("COMMIT");

    // The raw key is returned only at creation time.
    return {
      tenant,
      apiKey: {
        ...apiKey,
        secret: rawApiKey,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

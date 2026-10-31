
import { createTenantWithApiKey } from "../services/tenant.js";
import { pool } from "../config/db.js";

try {
  const result = await createTenantWithApiKey({
    tenantName: "Demo Company",
    apiKeyName: "Development key",
  });

  console.log("Tenant created successfully:");
  console.log(result.tenant);

  console.log("\nAPI key created successfully:");
  console.log({
    id: result.apiKey.id,
    prefix: result.apiKey.key_prefix,
    secret: result.apiKey.secret,
  });

  console.log(
    "\nIMPORTANT: Save the secret securely. It won't be retrievable from the database."
  );
} catch (error) {
  console.error("Tenant creation failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}


export async function createApiKey(db, {
  tenantId,
  name,
  keyPrefix,
  keyHash,
}) {
  const result = await db.query(
    `INSERT INTO api_keys (
       tenant_id,
       name,
       key_prefix,
       key_hash
     )
     VALUES ($1, $2, $3, $4)
     RETURNING id, tenant_id, name, key_prefix, created_at`,
    [tenantId, name, keyPrefix, keyHash]
  );

  return result.rows[0];
}


export async function findActiveApiKeyByHash(db, keyHash) {
  const result = await db.query(
    `SELECT
       ak.id AS api_key_id,
       ak.tenant_id,
       t.name AS tenant_name
     FROM api_keys ak
     JOIN tenants t ON t.id = ak.tenant_id
     WHERE ak.key_hash = $1
       AND ak.revoked_at IS NULL
       AND (ak.expires_at IS NULL OR ak.expires_at > NOW())
       AND t.status = 'active'
     LIMIT 1`,
    [keyHash]
  );

  return result.rows[0] ?? null;
}

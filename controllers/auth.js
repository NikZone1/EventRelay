
export function getCurrentTenant(req, res) {
  res.status(200).json({
    tenantId: req.auth.tenantId,
    apiKeyId: req.auth.apiKeyId,
  });
}

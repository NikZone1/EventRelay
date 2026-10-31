
import { createHash } from "node:crypto";
import { pool } from "../config/db.js";
import { findActiveApiKeyByHash } from "../models/apiKey.js";

export async function authenticateApiKey(req, res, next) {
  const authorization = req.get("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return res.status(401).json({
      error: {
        code: "MISSING_API_KEY",
        message: "A valid API key is required.",
      },
    });
  }

  const rawApiKey = authorization.slice("Bearer ".length).trim();

  if (!rawApiKey || rawApiKey.length > 200) {
    return res.status(401).json({
      error: {
        code: "INVALID_API_KEY",
        message: "The API key is invalid or inactive.",
      },
    });
  }

  try {
    const keyHash = createHash("sha256")
      .update(rawApiKey)
      .digest("hex");

    const apiKey = await findActiveApiKeyByHash(pool, keyHash);

    if (!apiKey) {
      return res.status(401).json({
        error: {
          code: "INVALID_API_KEY",
          message: "The API key is invalid or inactive.",
        },
      });
    }

    req.auth = {
      tenantId: apiKey.tenant_id,
      apiKeyId: apiKey.api_key_id,
    };

    next();
  } catch (error) {
    console.error("API-key authentication failed:", error.message);

    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal error occurred.",
      },
    });
  }
}

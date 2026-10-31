
import { Router } from "express";
import { authenticateApiKey } from "../middleware/auth.js";
import { getCurrentTenant } from "../controllers/auth.js";

const router = Router();

router.get("/me", authenticateApiKey, getCurrentTenant);

export default router;

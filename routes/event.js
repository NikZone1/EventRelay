
import { Router } from "express";
import { authenticateApiKey } from "../middleware/auth.js";
import {
  createEvent,
  replayDelivery,
} from "../controllers/event.js";

const router = Router();

router.post("/", authenticateApiKey, createEvent);
router.post(
  "/deliveries/:deliveryId/replay",
  authenticateApiKey,
  replayDelivery,
);

export default router;

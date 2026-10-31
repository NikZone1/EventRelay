
import { Router } from "express";
import authRoutes from "./auth.js";
import eventRoutes from "./event.js";


const router = Router();

router.use("/v1/auth", authRoutes);
router.use("/v1/events",eventRoutes);

export default router;

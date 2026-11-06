import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import markersRouter from "./markers";
import redemptionsRouter from "./redemptions";
import statsRouter from "./stats";
import controlRouter from "./control";
import pinPackagesRouter from "./pinPackages";
import paymentsRouter from "./payments";
import analyticsRouter from "./analytics";
import gamesRouter from "./games";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(pinPackagesRouter);
router.use(markersRouter);
router.use(redemptionsRouter);
router.use(statsRouter);
router.use(controlRouter);
router.use(paymentsRouter);
router.use(analyticsRouter);
router.use(gamesRouter);

router.use((req, res) => {
  res.status(404).json({ error: "Nie znaleziono." });
});

export default router;

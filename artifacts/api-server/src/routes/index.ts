import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import markersRouter from "./markers";
import redemptionsRouter from "./redemptions";
import statsRouter from "./stats";
import discoveriesRouter from "./discoveries";
import controlRouter from "./control";
import pinPackagesRouter from "./pinPackages";
import paymentsRouter from "./payments";
import analyticsRouter from "./analytics";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(pinPackagesRouter);
router.use(markersRouter);
router.use(redemptionsRouter);
router.use(statsRouter);
router.use(discoveriesRouter);
router.use(controlRouter);
router.use(paymentsRouter);
router.use(analyticsRouter);

export default router;

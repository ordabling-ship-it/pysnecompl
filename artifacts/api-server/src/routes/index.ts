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
import marketplaceRouter from "./marketplace";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(pinPackagesRouter);
// Marketplace has both public Odbiorca routes and session-protected Kreator
// routes. Mount it before legacy routers that install a catch-all requireAdmin
// middleware, otherwise public offer discovery and reservations would be
// rejected before marketplace can handle them.
router.use(marketplaceRouter);
router.use(markersRouter);
router.use(redemptionsRouter);
router.use(statsRouter);
router.use(discoveriesRouter);
router.use(controlRouter);
router.use(paymentsRouter);
router.use(analyticsRouter);

export default router;

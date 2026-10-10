import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import markersRouter from "./markers";
import redemptionsRouter from "./redemptions";
import statsRouter from "./stats";
import discoveriesRouter from "./discoveries";
import controlRouter from "./control";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(markersRouter);
router.use(redemptionsRouter);
router.use(statsRouter);
router.use(discoveriesRouter);
router.use(controlRouter);

export default router;

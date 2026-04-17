import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import markersRouter from "./markers";
import redemptionsRouter from "./redemptions";
import statsRouter from "./stats";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(markersRouter);
router.use(redemptionsRouter);
router.use(statsRouter);

export default router;

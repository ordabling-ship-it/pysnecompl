import { Router, type IRouter } from "express";
import { PIN_PACKAGES } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/pin-packages", (_req, res): void => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json(PIN_PACKAGES);
});

export default router;

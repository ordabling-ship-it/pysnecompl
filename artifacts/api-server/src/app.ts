import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pinoHttp from "pino-http";
import router from "./routes";
import { stripeWebhookHandler } from "./routes/payments";
import { logger } from "./lib/logger";

const app: Express = express();

// Preview deployments may point at the production users database so that the
// real accounts and password hashes remain the single source of truth. They
// must not be allowed to write production data, though. Render sets this flag
// only on the v2 preview service; login/logout remain available for safe auth
// and role checks.
const previewReadOnly = process.env.PYSNE_PREVIEW_READ_ONLY === "true";
const readOnlyAllowedPostRoutes = new Set(["/api/auth/admin-login", "/api/auth/logout"]);

if (previewReadOnly) {
  app.use("/api", (req, res, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !readOnlyAllowedPostRoutes.has(req.path)) {
      res.status(503).json({ error: "Podgląd v2 działa w trybie tylko do odczytu." });
      return;
    }
    next();
  });
}

// Render terminates TLS at its proxy; trust its forwarded protocol so secure
// cookies and same-origin checks use the public HTTPS origin.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
if (process.env.NODE_ENV !== "production") {
  app.use(cors());
}
app.use(cookieParser());
// Stripe requires the untouched request bytes to verify the webhook signature.
app.post("/api/payments/stripe/webhook", express.raw({ type: "application/json", limit: "2mb" }), stripeWebhookHandler);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.use("/api", router);

const frontendDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../treasure-hunt/dist/public",
);

app.use(express.static(frontendDist));
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/")) {
    next();
    return;
  }

  res.sendFile(path.join(frontendDist, "index.html"));
});

export default app;

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

const SPA_PATHS = new Set(["/", "/panel", "/activate", "/analytics"]);
const NOT_FOUND_HTML = `<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8"><title>Nie znaleziono — Pysne.com.pl</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family:sans-serif;padding:2rem"><h1>Nie znaleziono strony</h1><p><a href="/">Wróć na stronę główną</a></p></body></html>`;

function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  const policy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self' https://checkout.stripe.com",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://tile.openstreetmap.org",
    "connect-src 'self' https://nominatim.openstreetmap.org https://*.tile.openstreetmap.org",
  ];
  if (process.env.NODE_ENV === "production") policy.push("upgrade-insecure-requests");
  res.setHeader("Content-Security-Policy", policy.join("; "));
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

// Render terminates TLS at its proxy; trust its forwarded protocol so secure
// cookies and same-origin checks use the public HTTPS origin.
app.set("trust proxy", 1);
app.use(securityHeaders);

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

app.use(express.static(frontendDist, {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.split(path.sep).includes("assets")) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  },
}));
app.use((req, res) => {
  if (req.path.startsWith("/api")) {
    res.status(404).json({ error: "Nie znaleziono." });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(404).type("html").send(NOT_FOUND_HTML);
    return;
  }
  const normalized = req.path.replace(/\/+$/, "") || "/";
  if (SPA_PATHS.has(normalized)) {
    res.sendFile(path.join(frontendDist, "index.html"));
    return;
  }
  res.status(404).type("html").send(NOT_FOUND_HTML);
});

export default app;

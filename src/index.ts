import "dotenv/config";
import { initSentry, Sentry } from "./sentry";
initSentry(); // must run before any other module that might throw
import express, { NextFunction, Request, Response } from "express";
import testRouter from "./routes/test";
import dbRouter from "./routes/db";
import booksRouter from "./routes/books";
import chatRouter from "./routes/chat";
import trainRouter from "./routes/train";
import agentRouter, { startStalledScanner, spawnBulkWorker } from "./routes/agent";
import playbooksRouter from "./routes/playbooks";
import schedulesRouter from "./routes/schedules";
import alertsRouter from "./routes/alerts";
import internalRouter from "./routes/internal";
import { startScheduler } from "./services/scheduler";
import { initializePgVector } from "./db";
import { tenantMiddleware } from "./utils/http";

const app = express();
const PORT = process.env.PORT ?? 3001;

const corsOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isDevLocalhostOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (typeof origin === "string") {
    const allowed =
      corsOrigins.includes(origin) ||
      (process.env.NODE_ENV !== "production" && isDevLocalhostOrigin(origin));
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS,PUT,PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
}

app.use(corsMiddleware);
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? "25mb" }));

// /test and /db are diagnostics — left unscoped on purpose.
app.use("/test", testRouter);
app.use("/db", dbRouter);

// Everything else is per-company and must come through the rs-client proxy.
app.use("/books", tenantMiddleware, booksRouter);
app.use("/chat", tenantMiddleware, chatRouter);
app.use("/train", tenantMiddleware, trainRouter);
app.use("/agent", tenantMiddleware, agentRouter);
app.use("/playbooks", tenantMiddleware, playbooksRouter);
app.use("/schedules", tenantMiddleware, schedulesRouter);
app.use("/alerts", tenantMiddleware, alertsRouter);
// /internal — rs-server's outbound calls (dispatch declaration, etc).
// tenantMiddleware enforces X-Internal-Secret + X-Company-Id which is
// exactly what we want for service-to-service auth.
app.use("/internal", tenantMiddleware, internalRouter);

// Catch-all error handler — captures anything routes throw without
// their own try/catch and ships it to Sentry with tenant context.
// Must be the LAST middleware so it sees all errors. Defined inline
// so we don't accidentally double-register on test reloads.
app.use(
  (err: Error & { status?: number }, req: Request, res: Response, _next: NextFunction) => {
    const status = typeof err.status === "number" ? err.status : 500;
    if (status >= 500) {
      Sentry.withScope((scope) => {
        if (req.companyId) scope.setTag("company_id", req.companyId);
        if (req.userId) scope.setUser({ id: req.userId });
        scope.setTag("route", req.path);
        Sentry.captureException(err);
      });
      console.error("[unhandled]", req.method, req.path, err);
    }
    res.status(status).json({
      success: false,
      message: err.message || "Internal error",
    });
  },
);

if (require.main === module) {
  initializePgVector()
    .then(() => {
      startStalledScanner();
      startScheduler({ spawnBulkWorker });
      app.listen(PORT, () => {
        console.log(`Backend running on http://localhost:${PORT}`);
      });
    })
    .catch((error) => {
      console.error("Failed to initialize PostgreSQL/pgvector connection", error);
      process.exit(1);
    });
}

export { app };

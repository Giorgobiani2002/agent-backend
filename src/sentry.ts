import * as Sentry from "@sentry/node";

/**
 * Initialise Sentry early so unhandled errors anywhere in the process
 * (Express handlers, scheduler tick, Python subprocess stdout) get
 * captured with stack traces and tenant context.
 *
 * No-op when `SENTRY_DSN` is unset — useful for dev boxes and CI.
 * Call once from src/index.ts BEFORE any other imports that might
 * throw on startup.
 */
let initialised = false;

export function initSentry(): void {
  if (initialised) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log("[sentry] SENTRY_DSN not set — error reporting disabled");
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "development",
    release: process.env.RAILWAY_DEPLOYMENT_ID ?? undefined,
    // Sample rate kept conservative — 100% for errors, 10% for traces.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    // We don't want to capture every chat message body — Sentry's
    // beforeSend hook strips request bodies for /chat routes to avoid
    // leaking customer tax data into the error-tracking service.
    beforeSend(event) {
      const url = event.request?.url ?? "";
      if (url.includes("/chat") || url.includes("/agent/")) {
        if (event.request) delete event.request.data;
      }
      return event;
    },
  });
  initialised = true;
  console.log(`[sentry] initialised (env=${process.env.RAILWAY_ENVIRONMENT_NAME ?? "?"})`);
}

/**
 * Tag the current Sentry scope with the tenant making the request.
 * Call from inside a route handler after `tenantMiddleware` has
 * populated `req.companyId`. Safe to call when Sentry is disabled.
 */
export function tagTenant(companyId: string, userId?: string): void {
  if (!initialised) return;
  Sentry.setTag("company_id", companyId);
  if (userId) Sentry.setUser({ id: userId });
}

export { Sentry };

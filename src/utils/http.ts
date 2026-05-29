import { NextFunction, Request, Response } from "express";
import { getErrorMessage, getErrorStatus } from "../errors";

export function sendError(res: Response, error: unknown): void {
  res.status(getErrorStatus(error)).json({
    success: false,
    message: getErrorMessage(error),
  });
}

export function asMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      companyId: string;
      userId?: string;
      isPlatformAdmin: boolean;
    }
  }
}

/**
 * Trust the rs-client proxy that calls us:
 *   X-Internal-Secret  must match AI_INTERNAL_SECRET (shared with rs-client)
 *   X-Company-Id       resolved tenant id from rs-server session
 *   X-User-Id          optional — calling user inside that company
 *
 * We never want this service to be reachable directly from the public internet
 * without the proxy in front. In production rely on network policy too.
 */
export function tenantMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expectedSecret = process.env.AI_INTERNAL_SECRET ?? "";

  if (expectedSecret && req.headers["x-internal-secret"] !== expectedSecret) {
    res.status(403).json({ success: false, message: "Internal secret mismatch" });
    return;
  }

  const companyHeader = req.headers["x-company-id"];
  const companyId = Array.isArray(companyHeader) ? companyHeader[0] : companyHeader;

  if (!companyId) {
    res.status(400).json({ success: false, message: "Missing X-Company-Id header" });
    return;
  }

  req.companyId = String(companyId);

  const userHeader = req.headers["x-user-id"];
  const userId = Array.isArray(userHeader) ? userHeader[0] : userHeader;
  if (userId) {
    req.userId = String(userId);
  }

  const adminHeader = req.headers["x-platform-admin"];
  const adminValue = Array.isArray(adminHeader) ? adminHeader[0] : adminHeader;
  req.isPlatformAdmin = adminValue === "1" || adminValue === "true";

  next();
}

/**
 * Use after tenantMiddleware on routes only platform admins should reach
 * (e.g. seeding the global knowledge base). Companies' regular users get 403.
 */
export function platformAdminOnly(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.isPlatformAdmin) {
    res.status(403).json({
      success: false,
      message: "Only platform admins can modify the shared knowledge base",
    });
    return;
  }
  next();
}

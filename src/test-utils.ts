import type { Test } from "supertest";

/**
 * Add the tenant headers the production rs-client proxy would add. Tests use
 * an empty AI_INTERNAL_SECRET so the secret check is skipped, but
 * X-Company-Id is still required by tenantMiddleware.
 */
export const TEST_COMPANY_ID = "test-co-00000000";
export const TEST_USER_ID = "test-user-00000000";

export function withTenant(req: Test): Test {
  return req
    .set("X-Company-Id", TEST_COMPANY_ID)
    .set("X-User-Id", TEST_USER_ID)
    .set("X-Platform-Admin", "0");
}

/**
 * Same as withTenant but marks the caller as a platform admin so it can hit
 * the books write routes guarded by platformAdminOnly.
 */
export function withAdmin(req: Test): Test {
  return req
    .set("X-Company-Id", TEST_COMPANY_ID)
    .set("X-User-Id", TEST_USER_ID)
    .set("X-Platform-Admin", "1");
}

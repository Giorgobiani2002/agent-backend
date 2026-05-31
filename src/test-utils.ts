import type { Test } from "supertest";

/**
 * Add the tenant headers the production rs-client proxy would add,
 * including the X-Internal-Secret that tenantMiddleware now requires
 * (it fails closed on a missing/empty secret). The value matches the
 * one pinned in jest.setup.ts.
 */
export const TEST_COMPANY_ID = "test-co-00000000";
export const TEST_USER_ID = "test-user-00000000";
export const TEST_INTERNAL_SECRET = "test-internal-secret";

export function withTenant(req: Test): Test {
  return req
    .set("X-Internal-Secret", TEST_INTERNAL_SECRET)
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
    .set("X-Internal-Secret", TEST_INTERNAL_SECRET)
    .set("X-Company-Id", TEST_COMPANY_ID)
    .set("X-User-Id", TEST_USER_ID)
    .set("X-Platform-Admin", "1");
}

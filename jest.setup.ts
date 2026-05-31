// Pin a known AI_INTERNAL_SECRET for tests.
//
// tenantMiddleware now FAILS CLOSED — an empty secret returns 503 (a
// dropped env var must never silently disable auth). So tests run with a
// configured secret and the withTenant / withAdmin helpers in
// src/test-utils.ts send the matching X-Internal-Secret header, exercising
// the same auth path as production.

process.env.AI_INTERNAL_SECRET = "test-internal-secret";

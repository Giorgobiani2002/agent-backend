// Clear AI_INTERNAL_SECRET before tests run.
//
// Importing `app` from `src/index.ts` triggers `dotenv/config`, which loads
// the real .env (where we set a real secret for the boot test). The
// tenantMiddleware enforces the secret when it's set, so tests would fail
// with HTTP 403 unless every withTenant() call also sent the secret header.
//
// We strip it here so the tests' existing `X-Company-Id` / `X-User-Id`
// headers are sufficient — matching the behaviour before the secret was
// added to .env. The withAdmin / withTenant helpers in src/test-utils.ts
// already set the company + admin headers; this just removes the secret
// requirement.

process.env.AI_INTERNAL_SECRET = "";

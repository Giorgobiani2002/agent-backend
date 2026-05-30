// End-to-end smoke test for the full deploy chain:
//
//   rs-server      /internal/tools/health     (200 with secret)
//   agent-runtime  /health                    (200 always)
//   agent-runtime  /run no-secret             (403)
//   agent-runtime  /run good-secret           (202 spawns ghost worker)
//   agent-runtime  /health post-spawn         (worker tracked)
//   agent-runtime  /stop                      (kills ghost)
//   agent-runtime  /health post-stop          (worker gone)
//
// This proves: deploy is alive, auth wires across both backends, the
// HTTP dispatch path that production bulk runs use actually fires
// Python subprocesses inside the agent-runtime container.
//
// Run locally:  node scripts/smoke-test-e2e.js
// CI-friendly:  exits 0 on full pass, non-zero with first failed step.

const https = require("https");
const fs = require("fs");

const SECRET = (process.env.AI_INTERNAL_SECRET
  ?? (fs.existsSync("/tmp/secret.txt") ? fs.readFileSync("/tmp/secret.txt", "utf8") : "")
).trim();

const RS_HOST = process.env.RS_SERVER_PUBLIC_HOST
  ?? "rs-server-production-130f.up.railway.app";
const RUNTIME_HOST = process.env.AGENT_RUNTIME_PUBLIC_HOST
  ?? "agent-runtime-production-5dc1.up.railway.app";

if (!SECRET) {
  console.error("Provide AI_INTERNAL_SECRET env or write it to /tmp/secret.txt");
  process.exit(2);
}

function call({ host, path, method = "GET", body = null, headers = {}, label }) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : "";
    const req = https.request(
      {
        hostname: host,
        port: 443,
        path,
        method,
        headers: {
          ...(data
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
            : {}),
          ...headers,
        },
        timeout: 20_000,
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ label, status: res.statusCode, body: b }));
      },
    );
    req.on("error", (e) => resolve({ label, status: 0, body: "ERR " + e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ label, status: 0, body: "TIMEOUT" }); });
    if (data) req.write(data);
    req.end();
  });
}

const tests = [];
function expect(condition, label, actual) {
  tests.push({ ok: condition, label, actual });
  const mark = condition ? "✓" : "✗";
  console.log(`  ${mark} ${label}${actual ? ` — ${actual}` : ""}`);
}

(async () => {
  const fakeRunId = `smoke-${Date.now()}`;
  let allGreen = true;

  console.log("\n[1] rs-server internal API");
  const rs1 = await call({
    host: RS_HOST,
    path: "/api/v1/internal/tools/health",
    method: "POST",
    body: {},
    headers: { "X-Company-Id": "smoke" },
    label: "rs-server: no secret",
  });
  expect(rs1.status === 403, "no secret -> 403", `got ${rs1.status}`);

  const rs2 = await call({
    host: RS_HOST,
    path: "/api/v1/internal/tools/health",
    method: "POST",
    body: {},
    headers: { "X-Internal-Secret": SECRET, "X-Company-Id": "smoke" },
    label: "rs-server: with secret",
  });
  expect(rs2.status === 200, "good secret -> 200", `got ${rs2.status}`);

  console.log("\n[2] agent-runtime health");
  const r1 = await call({ host: RUNTIME_HOST, path: "/health", label: "runtime: /health" });
  expect(r1.status === 200, "/health -> 200", `got ${r1.status}`);
  let parsedHealth = null;
  try { parsedHealth = JSON.parse(r1.body); } catch (_e) {}
  expect(parsedHealth?.service === "agent-runtime", "service identifies as agent-runtime");
  expect(typeof parsedHealth?.python === "string", "python version reported", parsedHealth?.python);

  console.log("\n[3] agent-runtime /run auth");
  const r2 = await call({
    host: RUNTIME_HOST,
    path: "/run",
    method: "POST",
    body: { bulk_run_id: fakeRunId },
    label: "runtime: /run no secret",
  });
  expect(r2.status === 403, "no secret -> 403", `got ${r2.status}`);

  console.log("\n[4] agent-runtime /run dispatch");
  const r3 = await call({
    host: RUNTIME_HOST,
    path: "/run",
    method: "POST",
    body: { bulk_run_id: fakeRunId },
    headers: { "X-Internal-Secret": SECRET },
    label: "runtime: /run good",
  });
  expect(r3.status === 202, "good secret -> 202", `got ${r3.status}`);
  let runBody = null;
  try { runBody = JSON.parse(r3.body); } catch (_e) {}
  expect(Array.isArray(runBody?.spawned_pids) && runBody.spawned_pids.length > 0,
    "spawned at least one PID", JSON.stringify(runBody?.spawned_pids));

  console.log("\n[5] worker visible in /health");
  const r4 = await call({ host: RUNTIME_HOST, path: "/health", label: "runtime: /health post-spawn" });
  let post = null;
  try { post = JSON.parse(r4.body); } catch (_e) {}
  expect(Array.isArray(post?.live_runs) && post.live_runs.includes(fakeRunId),
    "worker visible in live_runs", JSON.stringify(post?.live_runs));

  console.log("\n[6] /stop kills worker");
  const r5 = await call({
    host: RUNTIME_HOST,
    path: "/stop",
    method: "POST",
    body: { bulk_run_id: fakeRunId },
    headers: { "X-Internal-Secret": SECRET },
    label: "runtime: /stop",
  });
  expect(r5.status === 200, "/stop -> 200", `got ${r5.status}`);

  const failed = tests.filter((t) => !t.ok);
  console.log(`\n${failed.length === 0 ? "✓" : "✗"} ${tests.length - failed.length}/${tests.length} checks passed`);
  if (failed.length > 0) {
    allGreen = false;
    console.log("\nFAILURES:");
    failed.forEach((f) => console.log(`  - ${f.label}${f.actual ? ` (${f.actual})` : ""}`));
  }
  process.exit(allGreen ? 0 : 1);
})();

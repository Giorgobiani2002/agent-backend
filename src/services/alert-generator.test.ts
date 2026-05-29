import { classifyErrorText } from "./alert-generator";

describe("alert-generator: classifyErrorText", () => {
  it("buckets network failures", () => {
    // ETIMEDOUT is a posix error code, not a wall-clock timeout — it's a
    // network reachability failure, so it goes to the network bucket.
    expect(classifyErrorText("ETIMEDOUT")).toBe("network");
    expect(classifyErrorText("ECONNRESET reading from rs.ge")).toBe("network");
    expect(classifyErrorText("socket hang up")).toBe("network");
  });

  it("buckets wall-clock timeouts separately from network", () => {
    expect(classifyErrorText("operation timed out after 30s")).toBe("timeout");
    expect(classifyErrorText("Timeout reached")).toBe("timeout");
  });

  it("buckets rate limits and auth", () => {
    expect(classifyErrorText("429 Too Many Requests")).toBe("rate_limit");
    expect(classifyErrorText("Hit rate limit on upstream")).toBe("rate_limit");
    expect(classifyErrorText("HTTP 401 Unauthorized")).toBe("auth");
    expect(classifyErrorText("Access denied for waybill.send")).toBe("auth");
  });

  it("buckets 5xx as portal_error", () => {
    expect(classifyErrorText("502 Bad Gateway")).toBe("portal_error");
    expect(classifyErrorText("Service Unavailable")).toBe("portal_error");
  });

  it("buckets validation problems", () => {
    expect(classifyErrorText("Invalid TIN format")).toBe("validation");
    expect(classifyErrorText("Required field missing: buyer_un_id")).toBe(
      "validation",
    );
  });

  it("falls back to unknown for unmatched text", () => {
    expect(classifyErrorText("something weird happened")).toBe("unknown");
    expect(classifyErrorText(null)).toBe("unknown");
    expect(classifyErrorText("")).toBe("unknown");
  });
});

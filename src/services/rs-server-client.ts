import { config } from "../config";

/**
 * Thin HTTP client for the rs-server `/internal/tools/*` surface used by
 * the chat tool-calling layer. Mirrors the auth pattern declario already
 * uses on the rs-client → agent-backend proxy: a shared secret
 * (`AI_INTERNAL_SECRET`) plus an `X-Company-Id` header.
 *
 * Errors are surfaced as `RsServerClientError` so the chat tool layer
 * can render a useful "the lookup failed: …" message to the model,
 * which is much more recoverable than a thrown stack trace.
 */
export class RsServerClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "RsServerClientError";
  }
}

interface RequestOpts {
  companyId: string;
  userId?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  timeoutMs?: number;
}

function buildUrl(path: string, query: RequestOpts["query"]): string {
  const base = config.rsServerUrl;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${base}${normalized}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  opts: RequestOpts,
): Promise<T> {
  if (!config.aiInternalSecret) {
    throw new RsServerClientError(
      "AI_INTERNAL_SECRET is not configured in agent-backend",
      500,
      null,
    );
  }
  const url = buildUrl(path, opts.query);
  const headers: Record<string, string> = {
    "X-Internal-Secret": config.aiInternalSecret,
    "X-Company-Id": opts.companyId,
    Accept: "application/json",
  };
  if (opts.userId) headers["X-User-Id"] = opts.userId;
  if (method === "POST") headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 15_000,
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new RsServerClientError(
      `rs-server request failed: ${err instanceof Error ? err.message : String(err)}`,
      0,
      null,
    );
  } finally {
    clearTimeout(timeout);
  }

  // rs-server wraps responses in `{ success, data }` via its ResponseInterceptor.
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as Record<string, unknown>).message)
        : `rs-server ${response.status} ${response.statusText}`;
    throw new RsServerClientError(message, response.status, parsed);
  }

  // Unwrap the standard envelope when present so callers see plain payloads.
  if (
    parsed &&
    typeof parsed === "object" &&
    "data" in parsed &&
    "success" in parsed
  ) {
    return (parsed as { data: T }).data;
  }
  return parsed as T;
}

export const rsServerClient = {
  get<T>(path: string, opts: RequestOpts): Promise<T> {
    return request<T>("GET", path, opts);
  },
  post<T>(path: string, opts: RequestOpts): Promise<T> {
    return request<T>("POST", path, opts);
  },
};

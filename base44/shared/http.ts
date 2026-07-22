// HTTP plumbing shared by every API function.
// Denial responses are constant-shape: unknown targets and unauthorized targets
// return the identical body so nothing about hidden data can be inferred.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Unauthorized and nonexistent targets are indistinguishable by design. */
export function deny(): ApiError {
  return new ApiError(404, "not_found");
}

export function unauthorized(): ApiError {
  return new ApiError(401, "unauthorized");
}

/** Member lacks the capability for an action inside a workspace they belong to. */
export function forbidden(): ApiError {
  return new ApiError(403, "forbidden");
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, "bad_request", message);
}

/**
 * A log-safe descriptor for an error. Never returns the error object itself:
 * SDK/axios errors echo the failed request (`config.data`), which can contain
 * private search text, raw invitation tokens, or signed file URLs. Only the
 * error's type and HTTP status are safe to record.
 */
export function safeError(err: unknown): string {
  const status = (err as any)?.response?.status ?? (err as any)?.status;
  const name = (err as any)?.name ?? typeof err;
  return status ? `${name}(status=${status})` : String(name);
}

type ActionHandler = (payload: Record<string, unknown>, req: Request) => Promise<unknown>;

/**
 * Standard entry-point wrapper: dispatches `{ action, payload }` request bodies
 * to named handlers and converts ApiError into sanitized JSON responses.
 * Unexpected errors are logged server-side and returned as a generic 500.
 */
export function serveActions(handlers: Record<string, ActionHandler>): void {
  Deno.serve(async (req: Request) => {
    let action = "";
    try {
      const body = await req.json().catch(() => ({}));
      action = typeof body?.action === "string" ? body.action : "";
      const handler = handlers[action];
      if (!handler) throw badRequest(`Unknown action: ${action || "(none)"}`);
      const result = await handler(body.payload ?? {}, req);
      return Response.json({ ok: true, data: result ?? null });
    } catch (err) {
      if (err instanceof ApiError) {
        return Response.json(
          { ok: false, error: err.code, message: err.status === 400 ? err.message : undefined },
          { status: err.status },
        );
      }
      console.error(`[api] unhandled error in action "${action}":`, err);
      return Response.json({ ok: false, error: "internal" }, { status: 500 });
    }
  });
}

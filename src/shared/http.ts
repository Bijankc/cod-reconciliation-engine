/** Small JSON response helpers, so every route answers in the same shape. */

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

export interface FieldError {
  field: string;
  message: string;
}

/** 400 with per-field detail — a validation error should say what to fix. */
export function validationFailed(errors: FieldError[]): Response {
  return json({ error: "validation_failed", details: errors }, 400);
}

export function badRequest(message: string): Response {
  return json({ error: "bad_request", message }, 400);
}

export function notFound(resource: string, id?: string): Response {
  return json({ error: "not_found", resource, ...(id ? { id } : {}) }, 404);
}

export function methodNotAllowed(allowed: string[]): Response {
  return json({ error: "method_not_allowed", allowed }, 405, { allow: allowed.join(", ") });
}

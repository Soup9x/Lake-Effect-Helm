/**
 * Calling Helm's own API from the browser.
 *
 * WHY THIS IS A MODULE AND NOT FIFTY COPIES. Every client component that wrote
 * to the API had its own rendering of the same eleven lines: build the
 * request, `fetch`, `response.json().catch(() => null)`, dig `error.message`
 * out of the envelope with an inline type for it, fall back to a sentence with
 * the status in it, and catch the network failure with a sentence of its own.
 * Thirty-six files carried it; fifty-two carried the inline type; the network
 * sentence existed in three wordings. None of that was wrong, and all of it was
 * the same decision made separately each time, which is how one copy ends up
 * reading `error.code` as undefined and a prompt quietly stops opening.
 *
 * THE CONTRACT. Every route answers with JSON, and every refusal is the
 * envelope errors.ts defines: `{ error: { code, message, details?, requestId } }`.
 * So one function can turn any response into a result a component can branch
 * on without knowing the status code, and the result has the shape the step-up
 * retry rule already reads (`AttemptResult` in step-up.ts is this type).
 *
 * WHAT A FAILURE SAYS. The server's message, verbatim, when there is one: it
 * was written to be shown. A fixed sentence with the status when there is not
 * — a proxy's 502 page is HTML, and reading it would show the person a proxy's
 * HTML. And one sentence, `NETWORK_FAILURE`, when the request never reached a
 * server at all, because the three wordings in use meant the same thing.
 */

export interface ApiSuccess<T> {
  readonly ok: true;
  readonly status: number;
  readonly value: T;
}

export interface ApiFailure {
  readonly ok: false;
  /** 0 when the request never reached a server. */
  readonly status: number;
  /** The envelope's code; `network` when there was no response; `http` when the response was not Helm's. */
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  /** The audit row a refusal was recorded as, when the route says so. */
  readonly auditEventUid?: string;
  readonly requestId?: string;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

/** The one sentence for "nothing answered". */
export const NETWORK_FAILURE = 'The request did not reach the server.';

export interface ApiRequest {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Serialised as the JSON body, with the content type set. */
  readonly json?: unknown;
  /** Sent as-is: a FormData, a Blob. Not with `json`. */
  readonly body?: BodyInit;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}

/**
 * The feedback line under a form: what happened, and whether it was good.
 *
 * Null is "nothing to say yet". Six components defined this privately before
 * it lived here; they all meant the same thing.
 */
export type Feedback = { ok: boolean; message: string } | null;

/**
 * Call a route and get a result, never a thrown error.
 *
 * `T` is what the route returns on success and is the caller's claim, not
 * something checked here — the routes are ours and their shapes are typed on
 * the other side. A 204 resolves with `undefined` as the value.
 */
export async function apiFetch<T = unknown>(url: string, request: ApiRequest = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...request.headers };
  let body: BodyInit | undefined = request.body;
  if (request.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(request.json);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch {
    return { ok: false, status: 0, code: 'network', message: NETWORK_FAILURE };
  }

  const payload = await readJson(response);
  return toApiResult<T>(response.ok, response.status, payload);
}

/** The body as JSON, or null when there is none or it is not JSON. */
async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('json')) return null;
  return response.json().catch(() => null);
}

/**
 * Reduce a parsed response to a result.
 *
 * Exported for the few callers that have to read a body some other way (a
 * download that is a blob on success and an envelope on failure) and for the
 * tests, which can exercise every branch without a server.
 */
export function toApiResult<T>(ok: boolean, status: number, payload: unknown): ApiResult<T> {
  if (ok) return { ok: true, status, value: (payload === null ? undefined : payload) as T };

  const error = (payload as { error?: Record<string, unknown> } | null)?.error;
  const details = isRecord(error?.details) ? error.details : undefined;
  const auditEventUid = typeof details?.auditEventUid === 'string' ? details.auditEventUid : undefined;
  const requestId = typeof error?.requestId === 'string' ? error.requestId : undefined;

  return {
    ok: false,
    status,
    code: typeof error?.code === 'string' ? error.code : 'http',
    message: typeof error?.message === 'string' ? error.message : `The request failed (${status}).`,
    ...(details ? { details } : {}),
    ...(auditEventUid ? { auditEventUid } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

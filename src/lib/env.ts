/**
 * Integer settings from the environment, validated.
 *
 * Reading a setting with `Number(...)` and a `??` default was the pattern, and it turns a typo into
 * NaN that then flows on silently: a NaN pool size, a NaN timeout, and — the
 * case that mattered — a NaN HELM_TRUSTED_PROXY_HOPS that made clientIp() fall
 * back to the leftmost, client-controlled X-Forwarded-For entry and defeated
 * API token IP allowlisting. A malformed or out-of-range value now fails with
 * the variable's name instead.
 *
 * The raw value is passed in rather than looked up by name, so every call site
 * still names its variable as a literal property of process.env — which is what tests/unit/env-docs.test.ts
 * scans to check that every variable the code reads is documented.
 */
export function envInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(
      `${name}=${JSON.stringify(raw)} is not a whole number from ${bounds.min} to ${bounds.max}`,
    );
  }
  return value;
}

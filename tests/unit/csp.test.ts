/**
 * The Content Security Policy every page is served with (lib/ui/csp.ts). The
 * claims worth pinning are the ones that would be easy to loosen while fixing
 * something else: scripts need the nonce, and a page reaches nothing but Helm.
 */
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../src/lib/ui/csp';

describe('the Content Security Policy', () => {
  const policy = contentSecurityPolicy('abc123', false);

  it('runs only scripts carrying the nonce, and never inline or eval', () => {
    const scripts = policy.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(scripts).toContain("'nonce-abc123'");
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toContain('unsafe-inline');
    expect(scripts).not.toContain('unsafe-eval');
  });

  it('lets a page talk to, post to and be framed by nothing but Helm', () => {
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).not.toMatch(/https?:|\*/);
  });

  it('allows eval only in development', () => {
    expect(contentSecurityPolicy('n', true)).toContain("'unsafe-eval'");
  });
});

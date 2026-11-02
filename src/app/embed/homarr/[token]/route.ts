import type { NextRequest } from 'next/server';
import { readBoardView } from '@/lib/homarr/board';
import { renderBoardPage, renderUnavailablePage, type BoardTheme } from '@/lib/homarr/page';

/**
 * The Homarr status page (1240): what a Homarr iFrame widget shows.
 *
 * NO SESSION. The token in the path is the whole credential and opens this
 * page only. Every kind of failure (malformed, unknown, revoked) gets the same
 * answer, so the page cannot be used to learn whether a link was ever real.
 *
 * FRAMING. The only page in Helm that may be framed, and only by the Homarr
 * addresses written on its link: next.config.ts leaves X-Frame-Options off
 * /embed/, and this sets frame-ancestors from the row. The "not available"
 * page carries no data and may be framed anywhere, so that a revoked link
 * says so inside the Homarr widget rather than showing a browser error.
 *
 * NO SCRIPT. The page is plain HTML and inline CSS; the CSP forbids script
 * outright, and it refreshes itself with a meta refresh.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const search = request.nextUrl.searchParams;
  const theme: BoardTheme = (['dark', 'light'] as const).find((t) => t === search.get('theme')) ?? 'auto';
  const transparent = search.get('transparent') === '1';
  const refresh = clamp(Number(search.get('refresh') ?? 300), 60, 3600);

  const view = await readBoardView(decodeURIComponent(token));
  if (!view) {
    return html(renderUnavailablePage({ theme, transparent }), 404, '*');
  }

  return html(
    renderBoardPage(view, { theme, transparent, refresh, helmOrigin: helmOrigin(request) }),
    200,
    view.allowedOrigins.join(' '),
  );
}

function html(body: string, status: number, frameAncestors: string): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'Content-Security-Policy': [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        `frame-ancestors ${frameAncestors}`,
      ].join('; '),
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

/** Where "Open in Helm" links point: AUTH_URL when set, else the request. */
function helmOrigin(request: NextRequest): string {
  const configured = process.env.AUTH_URL?.replace(/\/+$/, '');
  if (configured) return configured;
  const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? request.nextUrl.host;
  return `${proto}://${host}`;
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : 300;
}

export const dynamic = 'force-dynamic';

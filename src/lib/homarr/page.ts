/**
 * The Homarr status page's HTML (1240).
 *
 * A string, not React: the page is served by a route handler with a CSP that
 * forbids script, so there is nothing to hydrate, and a template keeps the
 * whole response readable in one place. EVERY interpolated value goes through
 * esc() or is a number; the data is client names and labels people typed.
 */
import {
  type BoardExpiration, type BoardView, type Health, summariseIntegrations,
} from './board';

export type BoardTheme = 'auto' | 'dark' | 'light';

interface Options {
  theme: BoardTheme;
  transparent: boolean;
  refresh?: number;
  helmOrigin?: string;
}

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const LIGHT = `
  --bg: oklch(99% 0.002 250); --card: oklch(100% 0 0); --sunken: oklch(96.5% 0.004 250);
  --line: oklch(91% 0.006 250); --ink: oklch(24% 0.012 250); --muted: oklch(50% 0.012 250);
  --faint: oklch(63% 0.010 250); --brand: oklch(48% 0.13 235);
  --ok: oklch(55% 0.13 155); --warn: oklch(62% 0.14 70); --danger: oklch(55% 0.20 27);
  --danger-tint: oklch(96% 0.03 27); --warn-tint: oklch(96.5% 0.04 80);`;
const DARK = `
  --bg: oklch(18% 0.008 250); --card: oklch(22% 0.009 250); --sunken: oklch(15% 0.007 250);
  --line: oklch(30% 0.010 250); --ink: oklch(93% 0.006 250); --muted: oklch(72% 0.010 250);
  --faint: oklch(58% 0.010 250); --brand: oklch(70% 0.12 235);
  --ok: oklch(70% 0.13 155); --warn: oklch(78% 0.13 80); --danger: oklch(68% 0.18 27);
  --danger-tint: oklch(28% 0.06 27); --warn-tint: oklch(29% 0.05 80);`;

function styles(o: Options): string {
  const palette = o.theme === 'light' ? `:root{${LIGHT}}`
    : o.theme === 'dark' ? `:root{${DARK}}`
    : `:root{${LIGHT}} @media (prefers-color-scheme: dark){:root{${DARK}}}`;
  return `${palette}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:${o.transparent ? 'transparent' : 'var(--bg)'};color:var(--ink);
    font:13px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased}
  body{padding:12px}
  a{color:inherit;text-decoration:none}
  a:hover{text-decoration:underline}
  header{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:10px}
  header h1{font-size:13px;font-weight:600;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  header h1 span{color:var(--brand)}
  header small{color:var(--faint);font-size:11px;white-space:nowrap}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:8px;margin-bottom:12px}
  .tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;display:block}
  .tile b{display:block;font-size:20px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.15}
  .tile span{color:var(--muted);font-size:11px}
  .tile.danger{background:var(--danger-tint);border-color:color-mix(in oklch,var(--danger) 35%,transparent)}
  .tile.danger b{color:var(--danger)}
  .tile.warn{background:var(--warn-tint);border-color:color-mix(in oklch,var(--warn) 35%,transparent)}
  .tile.warn b{color:var(--warn)}
  .tile.zero b{color:var(--faint)}
  .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
  section{background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
  section h2{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
    padding:8px 10px;border-bottom:1px solid var(--line);background:var(--sunken)}
  ul{list-style:none}
  li{display:flex;align-items:center;gap:8px;padding:7px 10px;border-top:1px solid var(--line);min-width:0}
  li:first-child{border-top:0}
  .dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--faint)}
  .dot.ok{background:var(--ok)} .dot.warn,.dot.late,.dot.never{background:var(--warn)}
  .dot.danger,.dot.failing,.dot.expired,.dot.critical{background:var(--danger)}
  .dot.warning{background:var(--warn)} .dot.paused{background:var(--faint)}
  .main{flex:1;min-width:0}
  .main div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .main .sub{color:var(--muted);font-size:11px}
  .when{flex:none;font-size:11px;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
  .when.expired,.when.critical,.when.failing{color:var(--danger);font-weight:600}
  .when.warning,.when.late,.when.never{color:var(--warn)}
  .empty{padding:10px;color:var(--muted)}
  .center{min-height:calc(100vh - 24px);display:flex;flex-direction:column;align-items:center;justify-content:center;
    text-align:center;gap:4px;color:var(--muted)}
  .center b{color:var(--ink)}`;
}

function doc(title: string, body: string, o: Options): string {
  const refresh = o.refresh ? `<meta http-equiv="refresh" content="${Math.round(o.refresh)}">` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
${refresh}<title>${esc(title)}</title><style>${styles(o)}</style></head>
<body>${body}</body></html>`;
}

export function renderUnavailablePage(o: Options): string {
  return doc('Helm', `<div class="center"><b>This Helm link isn’t working</b>
<span>It may have been revoked. Make a new one in Helm under Administration → Integrations → Homarr.</span></div>`, o);
}

function ago(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function due(days: number): string {
  if (days < -1) return `${-days} days ago`;
  if (days === -1) return 'yesterday';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

const KIND_LABELS: Record<string, string> = {
  ssl_certificate: 'Certificate', domain_registration: 'Domain', device_warranty: 'Warranty',
  device_eol: 'End of life', license: 'Licence', contract: 'Contract', isp_contract: 'ISP contract',
  credential_rotation: 'Password rotation', api_token: 'API token', sop_review: 'SOP review',
  data_key_rotation: 'Key rotation',
};

const HEALTH_WORDS: Record<Health, string> = {
  ok: 'synced', late: 'late', failing: 'failing', paused: 'paused', never: 'not yet synced',
};

function link(href: string | undefined, inner: string, cls = ''): string {
  return href
    ? `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<div class="${cls}">${inner}</div>`;
}

function expirationItem(e: BoardExpiration, helm: string | undefined): string {
  const href = helm ? `${helm}/expirations?organizationId=${encodeURIComponent(e.organizationId)}` : undefined;
  const kind = KIND_LABELS[e.kind] ?? e.kind;
  return `<li><span class="dot ${esc(e.severity)}"></span>
<div class="main">${link(href, esc(e.label))}<div class="sub">${esc(e.organization)} · ${esc(kind)}${e.autoRenew ? ' · auto-renews' : ''}</div></div>
<span class="when ${esc(e.severity)}">${esc(due(e.daysRemaining))}</span></li>`;
}

export function renderBoardPage(view: BoardView, o: Options, now = Date.now()): string {
  const helm = o.helmOrigin;
  const c = view.counts;
  const tile = (n: number, label: string, tone: string, href?: string) =>
    link(href, `<b>${Number(n)}</b><span>${esc(label)}</span>`, `tile ${n === 0 ? 'zero' : tone}`);

  const tiles = `<div class="tiles">
${tile(c.expired, 'Expired', 'danger', helm && `${helm}/expirations?severity=expired`)}
${tile(c.critical, 'Due very soon', 'danger', helm && `${helm}/expirations?severity=critical`)}
${tile(c.warning, 'Due soon', 'warn', helm && `${helm}/expirations?severity=warning`)}
${tile(c.clients, 'Clients', '', helm && `${helm}/organizations`)}
${tile(c.devices, 'Devices', '', helm && `${helm}/assets`)}
</div>`;

  const sections: string[] = [];

  if (view.showDetails) {
    const items = view.expirations.map((e) => expirationItem(e, helm)).join('');
    sections.push(`<section><h2>Expiring</h2>${items
      ? `<ul>${items}</ul>`
      : '<p class="empty">Nothing expired or due in the next 30 days.</p>'}</section>`);
  }

  const providers = summariseIntegrations(view.integrations, now);
  const rows = providers.map((p) => {
    const count = p.connections > 1 ? ` · ${p.connections} connections` : '';
    const names = p.failingNames.length ? `<div class="sub">${esc(p.failingNames.join(', '))}</div>` : '';
    const when = p.worst === 'ok' ? ago(p.lastSuccessAt, now) : HEALTH_WORDS[p.worst];
    return `<li><span class="dot ${p.worst}"></span>
<div class="main"><div>${esc(p.label)}<span class="sub">${esc(count)}</span></div>${names}</div>
<span class="when ${p.worst}" title="Last successful sync ${esc(ago(p.lastSuccessAt, now))}">${esc(when)}</span></li>`;
  }).join('');
  sections.push(`<section><h2>Integrations</h2>${rows
    ? `<ul>${rows}</ul>`
    : '<p class="empty">No integrations are connected.</p>'}</section>`);

  const updated = new Date(view.generatedAt);
  const hhmm = `${String(updated.getUTCHours()).padStart(2, '0')}:${String(updated.getUTCMinutes()).padStart(2, '0')} UTC`;
  const body = `<header><h1>${link(helm, `<span>Helm</span> · ${esc(view.tenant)}`)}</h1><small>Updated ${hhmm}</small></header>
${tiles}<div class="cols">${sections.join('')}</div>`;
  return doc(`Helm · ${view.tenant}`, body, o);
}


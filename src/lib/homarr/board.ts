/**
 * Homarr board links (1240): a read-only Helm status page that a Homarr iFrame
 * widget frames.
 *
 * Token format: `helm_hb_<prefix>.<secret>`, the same shape as an API token
 * (lib/auth/tokens.ts) and for the same reasons: a visible prefix makes a
 * leaked link identifiable, and only SHA-256 of the whole token is stored.
 * It is NOT an API token. No route but /embed/homarr accepts it, and that page
 * reads one aggregated summary through helm.homarr_board_view().
 */
import { createHash, randomBytes } from 'node:crypto';
import type { HelmTx } from '../db/client';
import { db } from '../db/client';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_PATTERN = /^(helm_hb_[A-Za-z0-9]{8})\.([A-Za-z0-9_-]{32,64})$/;

/** Scheme, host and optional port: what CSP frame-ancestors can name exactly. */
export const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

export interface MintedBoardToken {
  token: string;
  prefix: string;
  hash: Buffer;
}

export function mintBoardToken(): MintedBoardToken {
  const bytes = randomBytes(8);
  let tail = '';
  for (const b of bytes) tail += ALPHABET[b % ALPHABET.length];
  const prefix = `helm_hb_${tail}`;
  const token = `${prefix}.${randomBytes(32).toString('base64url')}`;
  return { token, prefix, hash: hashBoardToken(token) };
}

export function hashBoardToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function parseBoardToken(raw: string): { prefix: string; full: string } | null {
  const match = TOKEN_PATTERN.exec(raw);
  return match ? { prefix: match[1]!, full: raw } : null;
}

/**
 * What a person typed as a Homarr address, reduced to its origin.
 * `https://homarr.example.com/board/home` → `https://homarr.example.com`.
 * Null for anything that is not an http(s) address.
 */
export function normaliseOrigin(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const origin = url.origin;
  return ORIGIN_PATTERN.test(origin) ? origin : null;
}

export interface BoardLinkRow {
  id: string;
  name: string;
  prefix: string;
  allowedOrigins: string[];
  showDetails: boolean;
  createdAt: string;
  createdByName: string | null;
  lastUsedAt: string | null;
  useCount: number;
  revokedAt: string | null;
}

interface RawLink {
  id: string; name: string; token_prefix: string; allowed_origins: string[]; show_details: boolean;
  created_at: Date; created_by_name: string | null; last_used_at: Date | null;
  use_count: number | string; revoked_at: Date | null;
}

export async function listBoardLinks(tx: HelmTx): Promise<BoardLinkRow[]> {
  const rows = await tx<RawLink[]>`SELECT * FROM helm.homarr_board_links()`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.token_prefix,
    allowedOrigins: r.allowed_origins,
    showDetails: r.show_details,
    createdAt: r.created_at.toISOString(),
    createdByName: r.created_by_name,
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    useCount: Number(r.use_count),
    revokedAt: r.revoked_at?.toISOString() ?? null,
  }));
}

export async function createBoardLink(
  tx: HelmTx,
  input: { name: string; allowedOrigins: string[]; showDetails: boolean },
): Promise<{ id: string; token: string }> {
  const minted = mintBoardToken();
  const [row] = await tx<{ id: string }[]>`
    SELECT helm.create_homarr_board_link(
      ${input.name}, ${minted.prefix}, ${minted.hash}, ${input.allowedOrigins}::text[], ${input.showDetails}
    ) AS id
  `;
  if (!row) throw new Error('the Homarr board link was not created');
  return { id: row.id, token: minted.token };
}

export async function revokeBoardLink(tx: HelmTx, id: string): Promise<void> {
  await tx`SELECT helm.revoke_homarr_board_link(${id}::uuid)`;
}

// ---------------------------------------------------------------------------
// The page's data.
// ---------------------------------------------------------------------------

export type Severity = 'expired' | 'critical' | 'warning';

export interface BoardExpiration {
  id: string;
  label: string;
  kind: string;
  organizationId: string;
  organization: string;
  nodeId: string | null;
  expiresAt: string;
  daysRemaining: number;
  severity: Severity;
  autoRenew: boolean;
}

export interface BoardIntegration {
  provider: string;
  name: string | null;
  status: string;
  syncEnabled: boolean;
  intervalMinutes: number;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  failures: number;
}

export interface BoardView {
  tenant: string;
  linkName: string;
  showDetails: boolean;
  allowedOrigins: string[];
  counts: { expired: number; critical: number; warning: number; clients: number; devices: number };
  expirations: BoardExpiration[];
  integrations: BoardIntegration[];
  generatedAt: string;
}

/**
 * The summary a token opens, or null for every kind of "no": malformed,
 * unknown, wrong secret, revoked, inactive tenant. The caller must not tell
 * them apart, because telling a visitor a link was revoked confirms it was real.
 */
export async function readBoardView(raw: string): Promise<BoardView | null> {
  const parsed = parseBoardToken(raw);
  if (!parsed) return null;
  const [row] = await db('app')<{ view: BoardView | null }[]>`
    SELECT helm.homarr_board_view(${parsed.prefix}, ${hashBoardToken(parsed.full)}) AS view
  `;
  return row?.view ?? null;
}

// ---------------------------------------------------------------------------
// Integration health, as the page words it.
// ---------------------------------------------------------------------------

const PROVIDER_LABELS: Record<string, string> = {
  ninja_one: 'NinjaOne',
  action1: 'Action1',
  microsoft_graph: 'Microsoft 365',
  proxmox: 'Proxmox',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.replace(/_/g, ' ');
}

export type Health = 'ok' | 'late' | 'failing' | 'paused' | 'never';

/**
 * One connection's health. "Late" is three missed intervals without a success,
 * the same patience the Integrations page shows before it says anything.
 */
export function integrationHealth(i: BoardIntegration, now = Date.now()): Health {
  if (!i.syncEnabled) return 'paused';
  if (i.failures > 0 || i.status === 'error' || i.status === 'degraded') return 'failing';
  if (!i.lastSuccessAt) return 'never';
  const age = now - Date.parse(i.lastSuccessAt);
  return age > Math.max(i.intervalMinutes, 15) * 3 * 60_000 ? 'late' : 'ok';
}

export interface ProviderSummary {
  provider: string;
  label: string;
  connections: number;
  worst: Health;
  lastSuccessAt: string | null;
  failingNames: string[];
}

const HEALTH_ORDER: Health[] = ['ok', 'paused', 'never', 'late', 'failing'];

/** One line per provider: how many connections, the worst of them, the newest success. */
export function summariseIntegrations(list: BoardIntegration[], now = Date.now()): ProviderSummary[] {
  const by = new Map<string, ProviderSummary>();
  for (const i of list) {
    const health = integrationHealth(i, now);
    const entry = by.get(i.provider) ?? {
      provider: i.provider, label: providerLabel(i.provider), connections: 0,
      worst: 'ok' as Health, lastSuccessAt: null, failingNames: [],
    };
    entry.connections += 1;
    if (HEALTH_ORDER.indexOf(health) > HEALTH_ORDER.indexOf(entry.worst)) entry.worst = health;
    if (i.lastSuccessAt && (!entry.lastSuccessAt || i.lastSuccessAt > entry.lastSuccessAt)) {
      entry.lastSuccessAt = i.lastSuccessAt;
    }
    if ((health === 'failing' || health === 'late') && i.name) entry.failingNames.push(i.name);
    by.set(i.provider, entry);
  }
  return [...by.values()].sort((a, b) => a.label.localeCompare(b.label));
}

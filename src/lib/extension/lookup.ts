/**
 * What the browser extension can find: the credentials for the site a tab is
 * on, and a search across them, for client credentials and the person's own
 * vault.
 *
 * EVERYTHING HERE RUNS UNDER RLS, as the person the extension token belongs
 * to, so a lookup can only ever return what that person could open in Helm.
 * Nothing here decrypts: the popup reveals one value at a time, through the
 * same audited routes the web interface uses.
 *
 * MATCHING. A client credential matches a site by its URL field — the host of
 * whatever was typed there, by helm.url_host() — and by any credential_domain
 * rule written for it (0070), whatever that rule says about autofill, because
 * a lookup fills nothing. A credential naming this exact host is a 'host'
 * match and listed first; one naming another host under the same registrable
 * domain is a 'site' match. An IP address or bare intranet name has no
 * registrable domain, so it only ever matches exactly.
 *
 * The suffix comparison is `right(host, n) = '.' || domain` rather than LIKE,
 * whose `_` would match any character.
 */
import type { HelmTx } from '../db/client';
import type { Site } from './site';
import type { ExtensionEntry } from './types';

const LIMIT = 50;

interface ClientRow {
  id: string;
  name: string;
  organization_id: string;
  organization_name: string;
  username: string | null;
  url: string | null;
  secret_id: string | null;
  has_totp: boolean;
  sensitivity: 'standard' | 'elevated' | 'critical' | null;
  requires_step_up: boolean | null;
  requires_reason: boolean | null;
  exact: boolean | null;
}

interface PersonalRow {
  id: string;
  name: string;
  username: string | null;
  url: string | null;
  has_password: boolean;
  has_totp: boolean;
  exact: boolean | null;
}

function clientEntry(r: ClientRow, matched: boolean): ExtensionEntry {
  const hasPassword = r.secret_id !== null && r.sensitivity !== null;
  return {
    kind: 'client',
    id: r.id,
    name: r.name,
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    username: r.username,
    url: r.url,
    match: matched ? (r.exact ? 'host' : 'site') : null,
    hasPassword,
    hasTotp: r.has_totp,
    passwordCopyable: hasPassword && r.sensitivity === 'standard' && r.requires_step_up === false,
    requiresReason: r.requires_reason === true,
    secretId: hasPassword ? r.secret_id : null,
  };
}

function personalEntry(r: PersonalRow, matched: boolean): ExtensionEntry {
  return {
    kind: 'personal',
    id: r.id,
    name: r.name,
    organizationId: null,
    organizationName: null,
    username: r.username,
    url: r.url,
    match: matched ? (r.exact ? 'host' : 'site') : null,
    hasPassword: r.has_password,
    hasTotp: r.has_totp,
    passwordCopyable: r.has_password,
    requiresReason: false,
    secretId: null,
  };
}

/** The credentials for one site, client ones first, then the person's own. */
export async function matchSite(tx: HelmTx, site: Site): Promise<ExtensionEntry[]> {
  const { host } = site;
  const domain = site.registrableDomain;

  const clients = await tx<ClientRow[]>`
    SELECT n.id, n.name, n.organization_id, o.name AS organization_name,
           c.username, c.url, c.secret_id, c.totp_secret_id IS NOT NULL AS has_totp,
           s.sensitivity, s.requires_step_up, s.requires_reason, m.exact
    FROM credential c
    JOIN asset_node n   ON n.id = c.id
    JOIN organization o ON o.id = n.organization_id
    LEFT JOIN secret s  ON s.id = c.secret_id AND s.deleted_at IS NULL
    CROSS JOIN LATERAL (
      SELECT helm.url_host(c.url) AS url_host
    ) u
    CROSS JOIN LATERAL (
      SELECT
        coalesce(u.url_host = ${host}, false)
        OR EXISTS (
          SELECT 1 FROM credential_domain cd
          WHERE cd.credential_id = c.id
            AND (
              (cd.match_type = 'exact_host' AND cd.host = ${host})
              OR (cd.match_type = 'subdomain_of'
                  AND (cd.host = ${host} OR right(${host}, length(cd.host) + 1) = '.' || cd.host))
              OR (cd.match_type = 'registrable_domain' AND cd.host = ${domain})
            )
        ) AS exact,
        coalesce(
          u.url_host = ${domain} OR right(u.url_host, length(${domain}) + 1) = '.' || ${domain},
          false
        ) AS same_site
    ) m
    WHERE n.archived_at IS NULL
      AND (m.exact OR m.same_site)
    ORDER BY m.exact DESC, lower(o.name), lower(n.name), n.id
    LIMIT ${LIMIT}
  `;

  const personal = await tx<PersonalRow[]>`
    SELECT p.id, p.name, p.username, p.url, p.has_password, p.has_totp, m.exact
    FROM personal_credential p
    CROSS JOIN LATERAL (SELECT helm.url_host(p.url) AS url_host) u
    CROSS JOIN LATERAL (
      SELECT coalesce(u.url_host = ${host}, false) AS exact,
             coalesce(
               u.url_host = ${domain} OR right(u.url_host, length(${domain}) + 1) = '.' || ${domain},
               false
             ) AS same_site
    ) m
    WHERE m.exact OR m.same_site
    ORDER BY m.exact DESC, lower(p.name), p.id
    LIMIT ${LIMIT}
  `;

  return [...clients.map((r) => clientEntry(r, true)), ...personal.map((r) => personalEntry(r, true))];
}

/** `%` and `_` are literal in what a person types. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * How close a name has to be, by pg_trgm's word_similarity, to count as a
 * near miss: "mircosoft" finds Microsoft 365 (0.43), "xyz" finds nothing.
 * Only for three characters or more, where trigrams mean something.
 */
const FUZZY = 0.35;

/**
 * A search by name, username, client or URL, client credentials first, as the
 * person types. A substring anywhere matches; so does a near miss on a name or
 * client, for a typo. Names that start with what was typed rank first, then
 * other substring matches, then near misses, closest first.
 */
export async function search(tx: HelmTx, q: string): Promise<ExtensionEntry[]> {
  const pattern = likePattern(q);
  const prefix = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const fuzzy = q.length >= 3;

  const clients = await tx<ClientRow[]>`
    SELECT n.id, n.name, n.organization_id, o.name AS organization_name,
           c.username, c.url, c.secret_id, c.totp_secret_id IS NOT NULL AS has_totp,
           s.sensitivity, s.requires_step_up, s.requires_reason, NULL::boolean AS exact
    FROM credential c
    JOIN asset_node n   ON n.id = c.id
    JOIN organization o ON o.id = n.organization_id
    LEFT JOIN secret s  ON s.id = c.secret_id AND s.deleted_at IS NULL
    CROSS JOIN LATERAL (
      SELECT
        n.name ILIKE ${pattern} OR c.username ILIKE ${pattern}
          OR o.name ILIKE ${pattern} OR c.url ILIKE ${pattern} AS substring,
        CASE WHEN ${fuzzy}
          THEN greatest(extensions.word_similarity(${q}, n.name),
                        extensions.word_similarity(${q}, o.name))
          ELSE 0 END AS closeness
    ) m
    WHERE n.archived_at IS NULL
      AND (m.substring OR m.closeness >= ${FUZZY})
    ORDER BY (n.name ILIKE ${prefix}) DESC, m.substring DESC, m.closeness DESC,
             lower(o.name), lower(n.name), n.id
    LIMIT ${LIMIT}
  `;

  const personal = await tx<PersonalRow[]>`
    SELECT p.id, p.name, p.username, p.url, p.has_password, p.has_totp, NULL::boolean AS exact
    FROM personal_credential p
    CROSS JOIN LATERAL (
      SELECT
        p.name ILIKE ${pattern} OR p.username ILIKE ${pattern} OR p.url ILIKE ${pattern} AS substring,
        CASE WHEN ${fuzzy} THEN extensions.word_similarity(${q}, p.name) ELSE 0 END AS closeness
    ) m
    WHERE m.substring OR m.closeness >= ${FUZZY}
    ORDER BY (p.name ILIKE ${prefix}) DESC, m.substring DESC, m.closeness DESC, lower(p.name), p.id
    LIMIT ${LIMIT}
  `;

  return [...clients.map((r) => clientEntry(r, false)), ...personal.map((r) => personalEntry(r, false))];
}

const SUGGESTIONS = 8;

interface Activity {
  last_used: Date | null;
  uses: number;
}

/**
 * What to offer when the site in front of the person matches nothing: what
 * they copied or opened lately, and what MSP staff copy most.
 *
 * helm.extension_credential_activity() (1121) supplies ids and counts from the
 * audit log, which the extension's token cannot read; everything else is
 * looked up here under RLS, so an id the person cannot open is dropped by the
 * join. Credentials opened in Helm itself (user_recent_view) count as recent
 * too, so a new pairing has something to show before its first copy.
 */
export async function suggestions(
  tx: HelmTx,
): Promise<{ recent: ExtensionEntry[]; popular: ExtensionEntry[] }> {
  const clients = await tx<(ClientRow & Activity)[]>`
    WITH activity AS (
      SELECT activity_entity_id AS secret_id, last_used_by_me, uses
      FROM helm.extension_credential_activity()
      WHERE activity_entity_type = 'secret'
    ),
    per_credential AS (
      SELECT c.id, a.last_used_by_me AS last_used, a.uses
      FROM activity a
      JOIN credential c ON c.secret_id = a.secret_id OR c.totp_secret_id = a.secret_id
      UNION ALL
      SELECT r.node_id, r.viewed_at, 0
      FROM user_recent_view r
      JOIN credential c ON c.id = r.node_id
    ),
    totals AS (
      SELECT id, max(last_used) AS last_used, sum(uses)::int AS uses
      FROM per_credential
      GROUP BY id
    )
    SELECT n.id, n.name, n.organization_id, o.name AS organization_name,
           c.username, c.url, c.secret_id, c.totp_secret_id IS NOT NULL AS has_totp,
           s.sensitivity, s.requires_step_up, s.requires_reason, NULL::boolean AS exact,
           t.last_used, t.uses
    FROM totals t
    JOIN credential c   ON c.id = t.id
    JOIN asset_node n   ON n.id = c.id
    JOIN organization o ON o.id = n.organization_id
    LEFT JOIN secret s  ON s.id = c.secret_id AND s.deleted_at IS NULL
    WHERE n.archived_at IS NULL
  `;

  const personal = await tx<(PersonalRow & Activity)[]>`
    SELECT p.id, p.name, p.username, p.url, p.has_password, p.has_totp, NULL::boolean AS exact,
           a.last_used_by_me AS last_used, 0 AS uses
    FROM helm.extension_credential_activity() a
    JOIN personal_credential p ON p.id = a.activity_entity_id
    WHERE a.activity_entity_type = 'personal_credential'
  `;

  const used = [
    ...clients.map((r) => ({ entry: clientEntry(r, false), lastUsed: r.last_used, uses: r.uses })),
    ...personal.map((r) => ({ entry: personalEntry(r, false), lastUsed: r.last_used, uses: 0 })),
  ];

  const recent = used
    .filter((u) => u.lastUsed !== null)
    .sort((a, b) => (b.lastUsed?.getTime() ?? 0) - (a.lastUsed?.getTime() ?? 0))
    .slice(0, SUGGESTIONS);
  const shown = new Set(recent.map((u) => u.entry.id));
  const popular = used
    .filter((u) => u.uses > 0 && !shown.has(u.entry.id))
    .sort((a, b) => b.uses - a.uses || a.entry.name.localeCompare(b.entry.name))
    .slice(0, SUGGESTIONS);

  return { recent: recent.map((u) => u.entry), popular: popular.map((u) => u.entry) };
}

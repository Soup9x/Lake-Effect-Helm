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

/** A search by name, username, client or URL, client credentials first. */
export async function search(tx: HelmTx, q: string): Promise<ExtensionEntry[]> {
  const pattern = likePattern(q);

  const clients = await tx<ClientRow[]>`
    SELECT n.id, n.name, n.organization_id, o.name AS organization_name,
           c.username, c.url, c.secret_id, c.totp_secret_id IS NOT NULL AS has_totp,
           s.sensitivity, s.requires_step_up, s.requires_reason, NULL::boolean AS exact
    FROM credential c
    JOIN asset_node n   ON n.id = c.id
    JOIN organization o ON o.id = n.organization_id
    LEFT JOIN secret s  ON s.id = c.secret_id AND s.deleted_at IS NULL
    WHERE n.archived_at IS NULL
      AND (n.name ILIKE ${pattern} OR c.username ILIKE ${pattern}
           OR o.name ILIKE ${pattern} OR c.url ILIKE ${pattern})
    ORDER BY (n.name ILIKE ${pattern}) DESC, lower(o.name), lower(n.name), n.id
    LIMIT ${LIMIT}
  `;

  const personal = await tx<PersonalRow[]>`
    SELECT p.id, p.name, p.username, p.url, p.has_password, p.has_totp, NULL::boolean AS exact
    FROM personal_credential p
    WHERE p.name ILIKE ${pattern} OR p.username ILIKE ${pattern} OR p.url ILIKE ${pattern}
    ORDER BY lower(p.name), p.id
    LIMIT ${LIMIT}
  `;

  return [...clients.map((r) => clientEntry(r, false)), ...personal.map((r) => personalEntry(r, false))];
}

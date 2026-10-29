/**
 * Saving a login from the browser extension (1200): where it can go, whether
 * a sign-in matches what Helm has, and the save and the update themselves.
 *
 * NARROWER THAN THE WEB INTERFACE. The extension saves a standard password
 * with a username and a website, under a client (optionally one of its sites)
 * or in the person's own vault, and changes only the password of one that
 * already exists. It never sets a sensitivity, a step-up, a reason or a rank:
 * the database refuses anything but a standard password from an extension
 * token anyway (1200's triggers), so asking would only offer a choice that
 * fails.
 *
 * THE PASSWORD IS NEVER ECHOED. Every function here takes one and returns
 * ids, names and states: what the web routes return.
 *
 * MATCHING A SIGN-IN. The site is worked out from the tab's URL here, as the
 * lookup does, and a stored login matches when it names that site and the
 * same username, case-insensitively. Whether its password is the one typed is
 * answered without decrypting a client secret (helm.extension_password_state,
 * a blind-index comparison); a personal entry is opened and compared here,
 * since the person owns it and nothing is revealed to anyone.
 */
import { timingSafeEqual } from 'node:crypto';
import type { HelmTx } from '../db/client';
import type { ActorRef } from '../secrets/service';
import { ApiError } from '../api/errors';
import { getBlindIndex, getSecretService } from '../services';
import { createEntry, getEntry, passwordOf, updateEntry } from '../personal/vault';
import { matchSite } from './lookup';
import type { Site } from './site';
import type { ExtensionDestinations, ExtensionEntry, ExtensionLoginCheck } from './types';

/** The permissions a save needs, which a pairing from before 1200 does not carry. */
export const SAVE_PERMISSIONS = ['secret:write', 'asset:write'] as const;

export function canSave(permissions: readonly string[]): boolean {
  return SAVE_PERMISSIONS.every((p) => permissions.includes(p));
}

/** Clients the person can see, with their sites, for the save prompt's picker. */
export async function listDestinations(tx: HelmTx, permissions: readonly string[]): Promise<ExtensionDestinations> {
  if (!canSave(permissions)) return { canSave: false, organizations: [] };
  const rows = await tx<{ id: string; name: string; sites: { id: string; name: string }[] | null }[]>`
    SELECT o.id, o.name,
           (SELECT json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.is_primary DESC, lower(s.name))
            FROM site s WHERE s.organization_id = o.id AND s.deleted_at IS NULL) AS sites
    FROM organization o
    WHERE o.deleted_at IS NULL AND o.status <> 'former'
    ORDER BY o.is_msp_internal DESC, lower(o.name), o.id
    LIMIT 500
  `;
  return {
    canSave: true,
    organizations: rows.map((r) => ({ id: r.id, name: r.name, sites: r.sites ?? [] })),
  };
}

const sameUser = (a: string | null, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

function equalStrings(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

async function passwordState(
  tx: HelmTx,
  tenantId: string,
  entry: ExtensionEntry,
  password: string,
): Promise<'same' | 'changed' | 'unknown'> {
  if (!entry.passwordCopyable) return 'unknown';
  if (entry.kind === 'personal') {
    const stored = await passwordOf(tx, tenantId, entry.id);
    if (stored === null) return 'changed';
    return equalStrings(stored, password) ? 'same' : 'changed';
  }
  const index = getBlindIndex();
  if (!index || !entry.secretId) return 'unknown';
  const hmac = index.compute(tenantId, Buffer.from(password, 'utf8'));
  const [row] = await tx<{ state: 'same' | 'changed' | 'unknown' }[]>`
    SELECT helm.extension_password_state(${entry.secretId}::uuid, ${hmac}) AS state
  `;
  return row?.state ?? 'unknown';
}

/**
 * After a sign-in: is this a login Helm does not have ('new'), one it has
 * with this password ('same'), or with another ('changed')? 'skip' when Helm
 * has it but the extension may not touch it (elevated, critical, step-up), or
 * cannot tell, so the person is not asked something the answer to which
 * would be refused.
 */
export async function checkLogin(
  tx: HelmTx,
  tenantId: string,
  site: Site,
  username: string,
  password: string,
  permissions: readonly string[],
): Promise<ExtensionLoginCheck> {
  const entries = await matchSite(tx, site);
  const mine = entries.filter((e) => sameUser(e.username, username));
  if (mine.length === 0) {
    return { state: canSave(permissions) ? 'new' : 'skip', host: site.host, entry: null, canSave: canSave(permissions) };
  }
  // The exact host first (matchSite's order), so the update goes to the
  // login named for this page when there are two.
  for (const entry of mine) {
    const state = await passwordState(tx, tenantId, entry, password);
    if (state === 'same') return { state: 'same', host: site.host, entry, canSave: canSave(permissions) };
  }
  const first = mine[0]!;
  const state = await passwordState(tx, tenantId, first, password);
  if (state === 'changed' && canSave(permissions)) {
    return { state: 'changed', host: site.host, entry: first, canSave: true };
  }
  return { state: 'skip', host: site.host, entry: first, canSave: canSave(permissions) };
}

export interface SaveInput {
  destination: { kind: 'personal' } | { kind: 'client'; organizationId: string; siteId?: string | null | undefined };
  name: string;
  username: string;
  password: string;
  url: string | null;
  tags: string[];
  notes?: string | undefined;
}

/** Lowercased, trimmed, de-duplicated and sorted, as every other tag write. */
function normaliseTags(raw: string[]): string[] {
  const cleaned = raw
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter((t) => t.length > 0 && t.length <= 60);
  return [...new Set(cleaned)].sort();
}

/** Save a new login. Returns where it went, never what it holds. */
export async function saveLogin(
  tx: HelmTx,
  actor: ActorRef,
  input: SaveInput,
): Promise<{ kind: 'client' | 'personal'; id: string; name: string }> {
  if (input.destination.kind === 'personal') {
    const entry = await createEntry(tx, actor.tenantId, actor.actorId, {
      name: input.name,
      username: input.username || null,
      url: input.url,
      notes: input.notes ?? null,
      password: input.password,
    });
    await tx`
      SELECT helm.audit('personal_vault.saved', 'personal_credential', ${entry.id}::uuid, 'success',
                        NULL, NULL, NULL, ${tx.json({ source: 'browser_extension', change: 'created' })}::jsonb)
    `;
    return { kind: 'personal', id: entry.id, name: entry.name };
  }

  const { organizationId } = input.destination;
  const siteId = input.destination.siteId ?? null;
  let node: { id: string } | undefined;
  try {
    // The same two rows, three with the credential, that POST /api/secrets
    // writes, in this one transaction. See that route for why all three.
    const created = await getSecretService().createInTransaction(
      tx,
      actor,
      { organizationId, kind: 'password', label: input.name, sensitivity: 'standard', requiresStepUp: false, requiresReason: false },
      input.password,
    );
    [node] = await tx<{ id: string }[]>`
      INSERT INTO asset_node (
        tenant_id, organization_id, site_id, node_type, name, notes, created_by, updated_by, tags
      )
      VALUES (
        ${actor.tenantId}::uuid, ${organizationId}::uuid, ${siteId}, 'credential'::node_type, ${input.name},
        ${input.notes ?? null}, ${actor.actorId}::uuid, ${actor.actorId}::uuid, ${normaliseTags(input.tags)}
      )
      RETURNING id
    `;
    if (!node) throw ApiError.conflict('the login could not be saved');
    await tx`
      INSERT INTO credential (id, tenant_id, node_type, credential_type, username, url, secret_id)
      VALUES (
        ${node.id}::uuid, ${actor.tenantId}::uuid, 'credential', 'standard_user'::credential_type,
        ${input.username || null}, ${input.url}, ${created.secretId}::uuid
      )
    `;
  } catch (error) {
    if ((error as { code?: string }).code === '23503') throw ApiError.invalid('no such client or site');
    throw error;
  }
  return { kind: 'client', id: node.id, name: input.name };
}

/**
 * Replace the password of a login Helm has for this site: a new version of a
 * client secret (the old one stays in its history), or the personal entry's.
 * The login must name the site the person just signed in to; the extension
 * cannot point this at some other credential.
 */
export async function updateLogin(
  tx: HelmTx,
  actor: ActorRef,
  site: Site,
  target: { kind: 'client' | 'personal'; id: string },
  password: string,
): Promise<{ kind: 'client' | 'personal'; id: string; name: string }> {
  const entry = (await matchSite(tx, site)).find((e) => e.kind === target.kind && e.id === target.id);
  if (!entry) throw ApiError.notFound(`Helm has no such login for ${site.host}`);
  if (!entry.passwordCopyable) {
    throw ApiError.forbidden(`${entry.name} is changed in Helm itself`);
  }

  if (entry.kind === 'personal') {
    if (!(await getEntry(tx, entry.id))) throw ApiError.notFound('no such entry');
    await updateEntry(tx, actor.tenantId, entry.id, { password });
    await tx`
      SELECT helm.audit('personal_vault.saved', 'personal_credential', ${entry.id}::uuid, 'success',
                        NULL, NULL, NULL, ${tx.json({ source: 'browser_extension', change: 'password' })}::jsonb)
    `;
    return { kind: 'personal', id: entry.id, name: entry.name };
  }

  await getSecretService().rotateInTransaction(
    tx,
    actor,
    entry.secretId!,
    password,
    `Updated from the browser extension after signing in to ${site.host}`,
  );
  return { kind: 'client', id: entry.id, name: entry.name };
}

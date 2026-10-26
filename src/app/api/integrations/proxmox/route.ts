import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { getSecretService } from '@/lib/services';
import { FINGERPRINT, normaliseFingerprint } from '@/lib/net/pinned-https';
import { BASE_URL, ProxmoxError, TOKEN_ID, listNodes, readClusterStatus, readVersion } from '@/lib/proxmox/client';
import { listProxmoxConnections } from '@/lib/proxmox/queries';

/**
 * Proxmox connections, one per cluster, each importing to one client (1110).
 *
 * GATED ON integration:hypervisor:manage, here and again in
 * helm.set_proxmox_connection().
 *
 * A NEW TOKEN IS TRIED FIRST: Helm reads the version and the hosts with it,
 * through the certificate pin if one is given, before anything is stored. A
 * wrong address, token or fingerprint is reported to the person who typed it,
 * and nothing is saved.
 *
 * THE SECRET IS ASKED FOR AGAIN whenever the address, certificate or token ID
 * changes, so the stored one is only ever sent where it was first tried. The
 * trigger in 1110 holds the address and certificate to that whatever writes
 * the row.
 */

/** system_sync's rank: the stored floor must never lock the worker out. */
const SYNC_ROLE_RANK = 80;

const schema = z.object({
  /** Absent adds a connection. */
  id: z.guid().optional(),
  organizationId: z.guid(),
  /** Absent or blank: the cluster's name, or the host's. */
  name: z.string().trim().max(120).optional(),
  baseUrl: z.string().trim()
    .transform((v) => v.replace(/\/+$/, ''))
    .pipe(z.string().regex(BASE_URL, 'an https address with no path, like https://pve.example.com:8006')),
  tokenId: z.string().trim().regex(TOKEN_ID, 'user@realm!token, like helm@pve!helm'),
  /** Absent keeps the stored secret. */
  tokenSecret: z.string().trim().min(8).max(500).optional(),
  /** The one certificate to trust, or null to trust this server's CAs. */
  tlsSha256: z.string().trim()
    .transform(normaliseFingerprint)
    .pipe(z.string().regex(FINGERPRINT, 'a SHA-256 fingerprint: 64 hex characters, colons allowed'))
    .nullable(),
  syncEnabled: z.boolean(),
  intervalMinutes: z.number().int().min(15).max(10080),
});

export const GET = tenantRoute(async ({ tx }) => ({ connections: await listProxmoxConnections(tx) }));

export const PUT = tenantRoute(
  async ({ tx, request, session }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid Proxmox connection', { issues: zodIssues(result.error) });
      return result.data;
    });

    const connections = await listProxmoxConnections(tx);
    const existing = body.id ? connections.find((c) => c.id === body.id) : undefined;
    if (body.id && !existing) throw ApiError.notFound('there is no such connection');

    const moved = existing && (existing.baseUrl !== body.baseUrl || existing.tlsSha256 !== body.tlsSha256
      || existing.tokenId !== body.tokenId);
    if (!body.tokenSecret && (!existing || moved)) {
      throw ApiError.invalid(existing
        ? 'enter the token secret again when changing the address, certificate or token ID, so they can be tried together'
        : 'the token secret is needed to connect Proxmox');
    }

    let secretId: string | null = null;
    let tested: { version: string | null; cluster: string | null; hosts: number } | null = null;

    if (body.tokenSecret) {
      try {
        const target = {
          baseUrl: body.baseUrl, tokenId: body.tokenId, tokenSecret: body.tokenSecret, pinnedSha256: body.tlsSha256,
        };
        const version = await readVersion(target);
        const cluster = await readClusterStatus(target).catch(() => []);
        const nodes = await listNodes(target);
        tested = {
          version: version.version ?? null,
          cluster: cluster.find((c) => c.type === 'cluster')?.name ?? null,
          hosts: nodes.length,
        };
        if (!body.name) body.name = tested.cluster ?? nodes[0]?.node ?? 'Proxmox';
      } catch (error) {
        if (error instanceof ProxmoxError) {
          throw ApiError.invalid(`${error.message}. Nothing was saved.`, {
            kind: error.kind,
            ...(error.remedy ? { remedy: error.remedy } : {}),
          });
        }
        throw error;
      }
    }

    const name = body.name || existing?.name || 'Proxmox';
    if (connections.some((c) => c.id !== existing?.id && c.organizationId === body.organizationId
        && c.name.toLowerCase() === name.toLowerCase())) {
      throw ApiError.conflict(`this client already has a Proxmox connection called ${name}; give this one another name`);
    }

    if (body.tokenSecret) {
      const [internal] = await tx<{ id: string }[]>`
        SELECT id FROM organization WHERE is_msp_internal AND deleted_at IS NULL LIMIT 1
      `;
      if (!internal) {
        throw ApiError.invalid('this MSP has no internal organisation to keep the secret in', {
          remedy: 'Mark your own organisation as the MSP\'s on the server; see docs/deployment/on-premises.md §6.',
        });
      }
      const created = await getSecretService().createInTransaction(
        tx,
        { tenantId: session.tenantId, actorId: session.actorId, actorType: session.actorType },
        {
          organizationId: internal.id,
          kind: 'api_key',
          label: `Proxmox API token secret (${body.tokenId})`,
          sensitivity: 'elevated',
          minRoleRank: Math.min(session.roleRank, SYNC_ROLE_RANK),
          requiresReason: false,
        },
        body.tokenSecret,
      );
      secretId = created.secretId;
    }

    await tx`
      SELECT helm.set_proxmox_connection(
        ${existing?.id ?? null}::uuid, ${body.organizationId}::uuid, ${name}, ${body.baseUrl},
        ${body.tokenId}, ${secretId}::uuid, ${body.tlsSha256}, ${body.syncEnabled}, ${body.intervalMinutes})
    `;

    return {
      connections: await listProxmoxConnections(tx),
      ...(tested ? { tested } : {}),
    };
  },
  { permissions: ['integration:hypervisor:manage'] },
);

export const dynamic = 'force-dynamic';

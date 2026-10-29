/**
 * Which integration keeps a record current, named the way the Integrations
 * page names it. Read from external_identity.external_type, whose prefix is
 * the provider's: action1_device, m365_sku, ninja_device, proxmox_guest, unifi_device.
 *
 * external_identity is readable only by tenant-wide actors (0200), so for
 * anybody scoped to some clients this answers null and no badge is shown.
 */
const PREFIXES: [string, string][] = [
  ['action1_', 'Action1'],
  ['m365_', 'Microsoft 365'],
  ['ninja_', 'NinjaOne'],
  ['proxmox_', 'Proxmox'],
  ['unifi_', 'UniFi'],
];

export function syncSourceLabel(externalType: string | null | undefined): string | null {
  if (!externalType) return null;
  return PREFIXES.find(([prefix]) => externalType.startsWith(prefix))?.[1] ?? null;
}

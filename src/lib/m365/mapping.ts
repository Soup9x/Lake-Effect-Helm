/**
 * Microsoft 365 records, as Helm records them (0990). Pure, so each rule —
 * who counts as a person, which subscriptions are worth a licence entry, what
 * a SKU is called — is a unit test.
 */
import { createHash } from 'node:crypto';
import type { GraphDomain, GraphGroup, GraphSku, GraphUser } from './client';

export interface MappedUser {
  graphId: string;
  values: Record<string, string>;
  sha256: Buffer;
}

/**
 * Who becomes a contact: an enabled member account with at least one licence.
 *
 * Shared mailboxes and rooms are disabled, unlicensed accounts; guests are not
 * members; break-glass and service accounts are usually unlicensed. What is
 * left is the people a technician gets a call from.
 */
export function isPerson(user: GraphUser): boolean {
  return user.accountEnabled !== false
    && (user.userType ?? 'Member') === 'Member'
    && Array.isArray(user.assignedLicenses) && user.assignedLicenses.length > 0;
}

function text(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

export function mapUser(user: GraphUser): MappedUser {
  let first = text(user.givenName, 100);
  let last = text(user.surname, 100);
  if (!first && !last) {
    // Only a display name: the last word is the surname, the rest the first.
    const parts = (text(user.displayName) ?? '').split(/\s+/).filter(Boolean);
    last = parts.length > 1 ? parts.pop()! : null;
    first = parts.join(' ') || null;
  }

  const upn = text(user.userPrincipalName, 254);
  const email = text(user.mail, 254) ?? (upn && !upn.includes('#EXT#') ? upn : null);

  const values: Record<string, string> = {
    first_name: first ?? last ?? email ?? user.id,
    last_name: first ? last ?? '' : '',
  };
  const put = (key: string, value: string | null) => {
    if (value) values[key] = value;
  };
  put('title', text(user.jobTitle));
  put('email', email?.toLowerCase() ?? null);
  put('phone', text(user.businessPhones?.[0], 60));
  put('mobile', text(user.mobilePhone, 60));

  const sha256 = createHash('sha256')
    .update(JSON.stringify(Object.keys(values).sort().map((k) => [k, values[k]])))
    .digest();

  return { graphId: user.id, values, sha256 };
}

/** A group as the contact page lists it. */
export type ProfileGroup = {
  name: string;
  kind: string;
};

/**
 * What Microsoft 365 knows about a person beyond the contact's own fields
 * (1060): shown read-only on the contact, and the aliases added as addresses.
 *
 * `groups` is left out, not empty, when the groups could not be read, so the
 * groups recorded last time are kept rather than wiped by a missing permission.
 * A type rather than an interface, so it is plain JSON to tx.json().
 */
export type MappedProfile = {
  department?: string;
  office?: string;
  company?: string;
  address?: string;
  phones?: string[];
  aliases?: string[];
  groups?: ProfileGroup[];
};

/** What kind of group, in the words the Microsoft 365 admin center uses. */
export function groupKind(group: GraphGroup): string {
  if (group.groupTypes?.includes('Unified')) return 'Microsoft 365';
  if (group.securityEnabled && group.mailEnabled) return 'Mail-enabled security';
  if (group.securityEnabled) return 'Security';
  if (group.mailEnabled) return 'Distribution list';
  return 'Group';
}

/**
 * Every other address the person receives mail at. Not the primary, which is
 * the contact's own email already, and not the *.onmicrosoft.com routing
 * address every mailbox has and nobody writes to.
 */
export function aliasesOf(user: GraphUser): string[] {
  const primary = (text(user.mail, 254) ?? '').toLowerCase();
  const aliases = new Set<string>();
  for (const proxy of user.proxyAddresses ?? []) {
    if (typeof proxy !== 'string' || !/^smtp:/i.test(proxy)) continue;
    const address = proxy.slice(5).trim().toLowerCase();
    if (!address || address.length > 254 || address === primary) continue;
    if (/\.onmicrosoft\.(com|de|us)$/.test(address)) continue;
    aliases.add(address);
  }
  return [...aliases].sort();
}

export function mapProfile(user: GraphUser, groups: ProfileGroup[] | null): MappedProfile {
  const profile: MappedProfile = {};
  const department = text(user.department);
  const office = text(user.officeLocation);
  const company = text(user.companyName);
  if (department) profile.department = department;
  if (office) profile.office = office;
  if (company) profile.company = company;

  const locality = [text(user.city), [text(user.state), text(user.postalCode)].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  const address = [text(user.streetAddress), locality, text(user.country)].filter(Boolean).join(', ');
  if (address) profile.address = address.slice(0, 500);

  const phones = (user.businessPhones ?? []).map((p) => text(p, 60)).filter((p): p is string => p !== null);
  if (phones.length > 0) profile.phones = phones.slice(0, 10);

  const aliases = aliasesOf(user);
  if (aliases.length > 0) profile.aliases = aliases.slice(0, 50);

  if (groups) {
    profile.groups = [...groups]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200);
  }
  return profile;
}

/**
 * Subscriptions that are free, viral or self-service sign-ups: no seats a
 * client pays for, so no licence entry.
 */
const FREE_SKUS = new Set([
  'FLOW_FREE', 'POWER_BI_STANDARD', 'POWERAPPS_VIRAL', 'POWERAPPS_DEV', 'TEAMS_EXPLORATORY',
  'WINDOWS_STORE', 'MICROSOFT_BUSINESS_CENTER', 'STREAM', 'RIGHTSMANAGEMENT_ADHOC',
  'CCIBOTS_PRIVPREV_VIRAL', 'MCOMEETADV_FREE', 'FORMS_PRO', 'DYN365_ENTERPRISE_VIRAL_TRIAL',
  'PROJECT_MADEIRA_PREVIEW_IW_SKU', 'Microsoft_Teams_Exploratory_Dept', 'MICROSOFT_FABRIC_FREE',
]);

/** The names people know, for the SKUs most MSP clients have. */
const SKU_NAMES: Record<string, string> = {
  O365_BUSINESS_ESSENTIALS: 'Microsoft 365 Business Basic',
  O365_BUSINESS_PREMIUM: 'Microsoft 365 Business Standard',
  SPB: 'Microsoft 365 Business Premium',
  O365_BUSINESS: 'Microsoft 365 Apps for Business',
  OFFICESUBSCRIPTION: 'Microsoft 365 Apps for Enterprise',
  STANDARDPACK: 'Office 365 E1',
  ENTERPRISEPACK: 'Office 365 E3',
  ENTERPRISEPREMIUM: 'Office 365 E5',
  SPE_E3: 'Microsoft 365 E3',
  SPE_E5: 'Microsoft 365 E5',
  SPE_F1: 'Microsoft 365 F3',
  M365_F1: 'Microsoft 365 F1',
  DESKLESSPACK: 'Office 365 F3',
  EXCHANGESTANDARD: 'Exchange Online (Plan 1)',
  EXCHANGEENTERPRISE: 'Exchange Online (Plan 2)',
  EXCHANGEARCHIVE_ADDON: 'Exchange Online Archiving',
  EXCHANGEDESKLESS: 'Exchange Online Kiosk',
  AAD_PREMIUM: 'Microsoft Entra ID P1',
  AAD_PREMIUM_P2: 'Microsoft Entra ID P2',
  EMS: 'Enterprise Mobility + Security E3',
  EMSPREMIUM: 'Enterprise Mobility + Security E5',
  INTUNE_A: 'Microsoft Intune Plan 1',
  ATP_ENTERPRISE: 'Microsoft Defender for Office 365 (Plan 1)',
  THREAT_INTELLIGENCE: 'Microsoft Defender for Office 365 (Plan 2)',
  DEFENDER_ENDPOINT_P1: 'Microsoft Defender for Endpoint P1',
  MDATP_XPLAT: 'Microsoft Defender for Endpoint P2',
  MCOEV: 'Teams Phone Standard',
  MCOPSTN1: 'Teams Domestic Calling Plan',
  MCOMEETADV: 'Teams Audio Conferencing',
  PHONESYSTEM_VIRTUALUSER: 'Teams Phone Resource Account',
  Microsoft_Teams_Premium: 'Teams Premium',
  PROJECTPROFESSIONAL: 'Project Plan 3',
  VISIOCLIENT: 'Visio Plan 2',
  POWER_BI_PRO: 'Power BI Pro',
  WIN10_VDA_E3: 'Windows Enterprise E3',
  Microsoft_365_Copilot: 'Microsoft 365 Copilot',
};

export interface MappedLicence {
  skuId: string;
  name: string;
  seatsPurchased: number;
  seatsUsed: number;
}

/** A paid subscription with seats, or null for one not worth an entry. */
export function mapSku(sku: GraphSku): MappedLicence | null {
  const part = sku.skuPartNumber ?? '';
  if (FREE_SKUS.has(part) || part.endsWith('_FREE') || part.includes('VIRAL')) return null;
  const purchased = Math.max(0, Math.trunc(sku.prepaidUnits?.enabled ?? 0));
  if (purchased === 0 && sku.capabilityStatus !== 'Warning') return null;
  // A huge seat count is a free tenant-wide entitlement, not something bought.
  if (purchased >= 10_000) return null;
  return {
    skuId: sku.skuId,
    name: SKU_NAMES[part] ?? (part ? part.replace(/_/g, ' ') : sku.skuId),
    seatsPurchased: purchased,
    seatsUsed: Math.max(0, Math.trunc(sku.consumedUnits ?? 0)),
  };
}

/** Verified domains the client owns; never the tenant's *.onmicrosoft.com. */
export function domainsToImport(domains: GraphDomain[]): string[] {
  return domains
    .filter((d) => d.isVerified !== false && !d.isInitial && !/\.onmicrosoft\.(com|de|us)$/i.test(d.id)
      && !/\.mail\.onmicrosoft\.com$/i.test(d.id))
    .map((d) => d.id.toLowerCase());
}

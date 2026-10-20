/**
 * The sections of Administration, in the order they are listed.
 *
 * One list for the overview's tiles and the sub-navigation, so the two cannot
 * disagree about what exists or what it is called. People, the audit log and
 * the documentation types have pages of their own elsewhere and are listed
 * here so Administration is the one place to find every administrative thing.
 */
export interface AdminSection {
  href: string;
  title: string;
  /** Shorter, for the sub-navigation. */
  short: string;
  detail: string;
  icon: 'general' | 'people' | 'security' | 'email' | 'integrations' | 'backups' | 'automation' | 'audit' | 'types';
}

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  {
    href: '/settings/general', title: 'General', short: 'General', icon: 'general',
    detail: 'This MSP’s name, the default sidebar, and when documentation counts as stale.',
  },
  {
    href: '/people', title: 'People & roles', short: 'People', icon: 'people',
    detail: 'Who has access, how they sign in, their roles and the clients they can see.',
  },
  {
    href: '/settings/security', title: 'Sign-in & security', short: 'Sign-in & security', icon: 'security',
    detail: 'Session limits, single sign-on, RADIUS, two-step for local accounts, and key custody.',
  },
  {
    href: '/settings/notifications', title: 'Email & notifications', short: 'Email & notifications', icon: 'email',
    detail: 'The mail relay, where notifications go, and when expiry warnings are sent.',
  },
  {
    href: '/settings/integrations', title: 'Integrations', short: 'Integrations', icon: 'integrations',
    detail: 'NinjaOne, Microsoft 365, UniFi, and domain and certificate checking.',
  },
  {
    href: '/settings/backups', title: 'Backups', short: 'Backups', icon: 'backups',
    detail: 'Where backups are written, how long they are kept, and the restore rehearsal.',
  },
  {
    href: '/settings/automation', title: 'Automation', short: 'Automation', icon: 'automation',
    detail: 'Service accounts for scripts and tools, and the identities background jobs run as.',
  },
  {
    href: '/settings/asset-types', title: 'Documentation types', short: 'Documentation types', icon: 'types',
    detail: 'The custom record types this MSP has defined, and the fields on each.',
  },
  {
    href: '/audit', title: 'Audit log', short: 'Audit log', icon: 'audit',
    detail: 'Append-only and hash-chained. Who revealed, exported, changed or was refused.',
  },
];

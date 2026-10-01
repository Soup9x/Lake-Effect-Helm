/**
 * What a CSV may contain, per category, and how a row becomes a record.
 *
 * ONE SPEC PER CATEGORY, declared rather than branched, because the importer's
 * three consumers all need the same answer: the preview needs to say which
 * columns it recognised, the validator needs to know what is required, and the
 * writer needs a typed payload. Three implementations of "what does `Name` mean
 * here" is how an import succeeds in preview and fails on commit.
 *
 * ALIASES EXIST BECAUSE NOBODY RE-TYPES AN EXPORT. The files that arrive are
 * LastPass, 1Password, IT Glue and Excel exports, and each calls the same column
 * something different. Matching is case-insensitive and ignores spaces,
 * underscores and hyphens, so `Last Name`, `last_name` and `LASTNAME` are one
 * column. That is a lot cheaper than a column-mapping interface, and it is right
 * nearly always; where it is wrong the preview shows it before anything is
 * written.
 */
import { ORG_CATEGORIES, type OrgCategory } from '../nav/org-categories';

export interface ImportField {
  /** The canonical name, shown in the preview and in the template. */
  key: string;
  label: string;
  required?: boolean;
  maxLength?: number;
  /** Other spellings seen in the wild. */
  aliases?: readonly string[];
  /** Rendered as a checkbox-ish truthy value: yes/true/1/y. */
  boolean?: boolean;
}

export interface ImportSpec {
  /** The category slug this imports into. */
  slug: string;
  label: string;
  fields: readonly ImportField[];
  /** A short line under the file picker. */
  hint: string;
}

/** `Last Name`, `last_name` and `LASTNAME` are the same column. */
export function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[\s_-]+/g, '');
}

const NAME: ImportField = {
  key: 'name', label: 'Name', required: true, maxLength: 200,
  aliases: ['title', 'label', 'hostname', 'devicename', 'assetname'],
};

/*
 * Assets share a spec: every creatable node_type takes a name, an optional
 * description and notes, and a criticality. The node_type itself comes from the
 * category being imported into rather than from a column — somebody importing
 * into Networks means networks, and a `type` column that disagreed would be a
 * way to write a device into the wrong list.
 */
const ASSET_FIELDS: readonly ImportField[] = [
  NAME,
  { key: 'description', label: 'Description', maxLength: 2000, aliases: ['summary'] },
  { key: 'notes', label: 'Notes', maxLength: 4000, aliases: ['comment', 'comments'] },
  { key: 'criticality', label: 'Criticality', aliases: ['priority', 'importance'] },
  { key: 'site', label: 'Site', maxLength: 200, aliases: ['location', 'sitename'] },
];

const CONTACT_FIELDS: readonly ImportField[] = [
  { key: 'firstName', label: 'First name', required: true, maxLength: 120,
    aliases: ['first', 'givenname', 'forename'] },
  { key: 'lastName', label: 'Last name', required: true, maxLength: 120,
    aliases: ['last', 'surname', 'familyname'] },
  { key: 'title', label: 'Job title', maxLength: 160, aliases: ['jobtitle', 'role', 'position'] },
  { key: 'email', label: 'Email', maxLength: 320, aliases: ['emailaddress', 'mail'] },
  { key: 'phone', label: 'Phone', maxLength: 40, aliases: ['telephone', 'tel', 'officephone', 'workphone'] },
  { key: 'mobile', label: 'Mobile', maxLength: 40, aliases: ['cell', 'cellphone', 'mobilephone'] },
  { key: 'notes', label: 'Notes', maxLength: 4000 },
  { key: 'isPrimary', label: 'Primary', boolean: true, aliases: ['primarycontact'] },
  { key: 'isTechnical', label: 'Technical', boolean: true, aliases: ['technicalcontact'] },
  { key: 'isBilling', label: 'Billing', boolean: true, aliases: ['billingcontact'] },
  { key: 'isEmergency', label: 'Emergency', boolean: true, aliases: ['emergencycontact'] },
];

const SITE_FIELDS: readonly ImportField[] = [
  NAME,
  { key: 'code', label: 'Code', maxLength: 40, aliases: ['shortcode', 'sitecode'] },
  { key: 'addressLine1', label: 'Address', maxLength: 200, aliases: ['address1', 'street', 'addressline1'] },
  { key: 'addressLine2', label: 'Address 2', maxLength: 200, aliases: ['address2'] },
  { key: 'city', label: 'City', maxLength: 120, aliases: ['town'] },
  { key: 'region', label: 'Region', maxLength: 120, aliases: ['state', 'province', 'county'] },
  { key: 'postalCode', label: 'Postcode', maxLength: 32, aliases: ['zip', 'zipcode', 'postcode'] },
  { key: 'country', label: 'Country', maxLength: 2, aliases: ['countrycode'] },
  { key: 'mainPhone', label: 'Phone', maxLength: 40, aliases: ['phone', 'telephone'] },
  { key: 'notes', label: 'Notes', maxLength: 4000 },
  { key: 'isPrimary', label: 'Primary', boolean: true },
];

/*
 * Passwords. The one spec whose cells are secret.
 *
 * `password` is required because a credential with no value is a documented
 * account rather than a vault entry, and the importer's whole purpose is moving
 * a vault. Everything else is the documentation around it.
 */
const PASSWORD_FIELDS: readonly ImportField[] = [
  { key: 'name', label: 'Name', required: true, maxLength: 200,
    aliases: ['title', 'label', 'account', 'accountname'] },
  { key: 'password', label: 'Password', required: true, maxLength: 65536,
    aliases: ['secret', 'value', 'pass'] },
  { key: 'username', label: 'Username', maxLength: 200, aliases: ['user', 'login', 'loginname'] },
  { key: 'url', label: 'URL', maxLength: 2000, aliases: ['website', 'uri', 'link'] },
  { key: 'notes', label: 'Notes', maxLength: 4000, aliases: ['comment', 'comments', 'extra'] },
  { key: 'totpSeed', label: 'One-time code seed', maxLength: 4096,
    aliases: ['totp', 'totpsecret', 'otp', 'otpsecret', 'otpauth', 'authkey'] },
];

const SPECS: readonly ImportSpec[] = [
  { slug: 'contacts', label: 'Contacts', fields: CONTACT_FIELDS,
    hint: 'One person per row. First and last name are required.' },
  { slug: 'locations', label: 'Locations', fields: SITE_FIELDS,
    hint: 'One site per row. Name is required.' },
  { slug: 'passwords', label: 'Passwords', fields: PASSWORD_FIELDS,
    hint: 'One credential per row. Name and password are required; the password is encrypted on arrival and never stored in the file you uploaded.' },
  // Every creatable asset category, sharing one spec.
  ...ORG_CATEGORIES.filter((c) => c.kind === 'node' && c.source !== 'credential' && c.source !== 'sop')
    .map<ImportSpec>((c: OrgCategory) => ({
      slug: c.slug,
      label: c.label,
      fields: ASSET_FIELDS,
      hint: `One ${c.label.replace(/s$/, '').toLowerCase()} per row. Name is required.`,
    })),
];

const BY_SLUG = new Map(SPECS.map((s) => [s.slug, s]));

/** Undefined where import does not apply: documents are files, SOPs are not creatable. */
export function importSpecFor(slug: string): ImportSpec | undefined {
  return BY_SLUG.get(slug);
}

/** A header line a person can paste back, for the "download a template" link. */
export function templateFor(spec: ImportSpec): string {
  return `${spec.fields.map((f) => f.label).join(',')}\n`;
}

/**
 * Map one parsed row onto canonical keys.
 *
 * Unrecognised columns are returned separately rather than dropped: the preview
 * says "these three columns were ignored", which is the difference between an
 * import that quietly lost the notes field and one that said so.
 */
export function mapRow(
  spec: ImportSpec,
  row: Record<string, string>,
): { values: Record<string, string>; ignored: string[] } {
  const byAlias = new Map<string, string>();
  for (const field of spec.fields) {
    byAlias.set(normaliseHeader(field.key), field.key);
    byAlias.set(normaliseHeader(field.label), field.key);
    for (const alias of field.aliases ?? []) byAlias.set(normaliseHeader(alias), field.key);
  }

  const values: Record<string, string> = {};
  const ignored: string[] = [];
  for (const [header, value] of Object.entries(row)) {
    const key = byAlias.get(normaliseHeader(header));
    if (key) {
      // First column wins when two map to the same field, so a file with both
      // `Login` and `Username` does not silently prefer whichever came last.
      if (values[key] === undefined || values[key] === '') values[key] = value;
    } else if (value !== '') {
      ignored.push(header);
    }
  }
  return { values, ignored };
}

const TRUE = new Set(['yes', 'y', 'true', 't', '1', 'x', '✓']);
export function asBoolean(value: string | undefined): boolean {
  return value !== undefined && TRUE.has(value.trim().toLowerCase());
}

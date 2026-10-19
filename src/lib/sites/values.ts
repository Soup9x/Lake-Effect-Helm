/**
 * A location as its form edits it, and the one place a site row becomes those
 * values. Lives outside the client component so server pages can build values
 * too: a function exported from a 'use client' module cannot be called on the
 * server.
 */
import type { FieldValue } from '../ui/form-diff';

export interface SiteValues extends Record<string, FieldValue> {
  name: string;
  code: string;
  isPrimary: boolean;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  timezone: string;
  mainPhone: string;
  afterHoursPhone: string;
  /** One per line while editing; cleaned before it is compared or sent (0840). */
  publicIps: string[];
  accessNotes: string;
  physicalSecurity: string;
  notes: string;
}

export const BLANK_SITE: SiteValues = {
  name: '',
  code: '',
  isPrimary: false,
  addressLine1: '',
  addressLine2: '',
  city: '',
  region: '',
  postalCode: '',
  country: 'US',
  timezone: '',
  mainPhone: '',
  afterHoursPhone: '',
  publicIps: [],
  accessNotes: '',
  physicalSecurity: '',
  notes: '',
};

/** The shape a page reads a site row in, turned into form values. */
export function siteValuesFrom(row: {
  name: string; code: string | null; is_primary: boolean;
  address_line1: string | null; address_line2: string | null; city: string | null; region: string | null;
  postal_code: string | null; country: string; timezone: string | null;
  main_phone: string | null; after_hours_phone: string | null; public_ips: string[] | null;
  access_notes: string | null; physical_security: string | null; notes: string | null;
}): SiteValues {
  return {
    name: row.name,
    code: row.code ?? '',
    isPrimary: row.is_primary,
    addressLine1: row.address_line1 ?? '',
    addressLine2: row.address_line2 ?? '',
    city: row.city ?? '',
    region: row.region ?? '',
    postalCode: row.postal_code ?? '',
    country: row.country,
    timezone: row.timezone ?? '',
    mainPhone: row.main_phone ?? '',
    afterHoursPhone: row.after_hours_phone ?? '',
    publicIps: row.public_ips ?? [],
    accessNotes: row.access_notes ?? '',
    physicalSecurity: row.physical_security ?? '',
    notes: row.notes ?? '',
  };
}


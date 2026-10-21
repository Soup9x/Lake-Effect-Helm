/**
 * A location's postal address on one line: street, suite, "City, Region
 * Postal", and the country when it is not the default.
 *
 * The country is left off when it is 'US', 0010's default, because on an MSP
 * whose clients are all in one country it is the same three letters on every
 * row; anywhere else it is the part that matters most.
 */
export interface AddressParts {
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

export function siteAddress(site: AddressParts): string | null {
  const clean = (v: string | null | undefined) => v?.trim() || null;
  const regionPostal = [clean(site.region), clean(site.postal_code)].filter(Boolean).join(' ');
  const locality = [clean(site.city), regionPostal || null].filter(Boolean).join(', ');
  const country = clean(site.country);
  const parts = [
    clean(site.address_line1),
    clean(site.address_line2),
    locality || null,
    country && country.toUpperCase() !== 'US' ? country : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

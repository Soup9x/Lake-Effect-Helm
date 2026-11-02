/**
 * Field view's settings vocabulary (1250). Plain data with no server imports,
 * so the Administration card (a client component) can share it with the
 * policy code that reads the database.
 */
export const FIELD_SECTIONS = ['logins', 'devices', 'contacts', 'locations', 'vault'] as const;
export type FieldSection = (typeof FIELD_SECTIONS)[number];

export const FIELD_SECTION_LABELS: Record<FieldSection, string> = {
  logins: 'Logins',
  devices: 'Devices',
  contacts: 'Contacts',
  locations: 'Locations',
  vault: 'My vault',
};

export interface FieldViewPolicy {
  enabled: boolean;
  idleMinutes: number;
  absoluteHours: number;
  criticalOnPhone: 'step_up' | 'block';
  sections: FieldSection[];
  updatedAt: Date | null;
}


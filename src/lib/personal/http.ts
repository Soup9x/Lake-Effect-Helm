import { z } from 'zod';
import { ApiError } from '../api/errors';

/** What a vault entry is written as, from the routes under /api/personal/vault. */
export const vaultEntrySchema = z.object({
  name: z.string().trim().min(1).max(200),
  username: z.string().trim().max(320).nullable().optional(),
  url: z.string().trim().max(2048).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  password: z.string().max(65_536).nullable().optional(),
  /** An otpauth:// URI or a base32 seed. */
  totp: z.string().trim().max(4096).nullable().optional(),
});

/**
 * A vault belongs to a person signed in as themselves. An API token or a
 * service account is refused outright, rather than shown an empty list it
 * might mistake for "nothing stored".
 */
export function requirePerson(identity: { actorType: string }): void {
  if (identity.actorType !== 'user') {
    throw ApiError.forbidden('a personal vault belongs to a person signed in as themselves');
  }
}

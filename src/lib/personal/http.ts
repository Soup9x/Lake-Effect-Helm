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
 *
 * One token is let through, and only where the caller says so: the person's
 * own browser extension, to list and open an entry (1120). The database says
 * the same thing independently — its read policy admits that token and its
 * write policy admits none.
 */
export function requirePerson(
  identity: { actorType: string; method?: string; tokenType?: string },
  options: { allowExtension?: boolean } = {},
): void {
  if (identity.actorType !== 'user') {
    throw ApiError.forbidden('a personal vault belongs to a person signed in as themselves');
  }
  if (identity.method === 'api_token') {
    if (options.allowExtension && identity.tokenType === 'browser_extension') return;
    throw ApiError.forbidden('a personal vault is not reachable with an API token');
  }
}

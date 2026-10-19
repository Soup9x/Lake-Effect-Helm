/**
 * A location's public IP addresses (0840): single addresses or CIDR blocks.
 *
 * Checked here so a typo comes back naming the expected shape rather than the
 * database's generic wrong-format refusal; the column's inet[] type refuses it
 * regardless.
 */
import { isIP } from 'node:net';
import { z } from 'zod';

export function isAddressOrBlock(value: string): boolean {
  const [address, prefix, extra] = value.split('/');
  if (extra !== undefined || !address) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

export const publicIpsSchema = z
  .array(
    z.string().trim().min(1).max(64)
      .refine(isAddressOrBlock, 'not an IP address or block — e.g. 203.0.113.10 or 203.0.113.8/29'),
  )
  .max(32, 'at most 32 public addresses');

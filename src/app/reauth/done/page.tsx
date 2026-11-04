import { ReauthDone } from '@/components/reauth-done';

/**
 * Where a single sign-on re-authentication window lands (1270). It tells the
 * Helm tab that opened it, then closes itself.
 */
export default async function ReauthDonePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  return <ReauthDone ticket={one(params.t)} ok={one(params.ok) === '1'} error={one(params.error) || null} />;
}

export const dynamic = 'force-dynamic';

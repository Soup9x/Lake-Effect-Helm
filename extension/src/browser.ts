/**
 * Which browser this is, for the name a pairing is given in Helm. Brave
 * reports itself as Chrome in its user agent and says otherwise only through
 * navigator.brave, so it is asked first.
 */
interface BrandNavigator extends Navigator {
  brave?: { isBrave?: () => Promise<boolean> };
  userAgentData?: { brands?: { brand: string }[]; platform?: string };
}

export async function browserName(): Promise<string> {
  const nav = navigator as BrandNavigator;
  try {
    if (nav.brave?.isBrave && (await nav.brave.isBrave())) return 'Brave';
  } catch {}
  const brands = nav.userAgentData?.brands?.map((b) => b.brand) ?? [];
  if (brands.includes('Microsoft Edge')) return 'Edge';
  if (brands.includes('Google Chrome')) return 'Chrome';
  return 'Chromium';
}

export function platformName(): string {
  const platform = (navigator as BrandNavigator).userAgentData?.platform ?? '';
  if (/mac/i.test(platform)) return 'Mac';
  if (/win/i.test(platform)) return 'Windows';
  if (/linux|chrome os/i.test(platform)) return platform;
  return platform || 'this computer';
}

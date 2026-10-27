/** `helm.example.com` or a full URL, to an origin; https only, except on this machine. */
export function normaliseServer(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  return url.origin;
}

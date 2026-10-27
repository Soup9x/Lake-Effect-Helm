/**
 * Where the extension is downloaded from: the GitHub release the
 * extension-release workflow publishes whenever the manifest's version rises.
 * `latest/download/<name>` always resolves to the newest one.
 */
export const EXTENSION_DOWNLOAD_URL =
  'https://github.com/Soup9x/Lake-Effect-Helm/releases/latest/download/helm-extension.zip';

/** Every release, for somebody who needs an older one or the notes. */
export const EXTENSION_RELEASES_URL = 'https://github.com/Soup9x/Lake-Effect-Helm/releases';

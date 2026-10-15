/**
 * Which image a client's avatar should load.
 *
 * TWO SOURCES, ON PURPOSE, AND ONE PLACE THAT CHOOSES BETWEEN THEM.
 *
 * `organization.logo_url` has existed since 0010 and holds whatever a
 * technician pasted — an internal file server, the client's own site, a data
 * URI. 0680 added `organization_logo`, which holds bytes somebody uploaded.
 * Both are legitimate and an install may well have the first and not the
 * second, so neither replaces the other.
 *
 * AN UPLOAD WINS. It is the newer, deliberate act, it is served from this
 * origin so it cannot break when somebody else's web server moves, and it is
 * the only one of the two Helm can promise will still render next year.
 *
 * THIS FUNCTION EXISTS SO THE THREE CALL SITES CANNOT DISAGREE. The clients
 * list, the client page and the recents strip all render ClientAvatar, and a
 * precedence rule written out three times is a precedence rule that is wrong in
 * one of them. `tests/unit/logo-src.test.ts` pins it.
 */
export function logoSrc(
  organizationId: string,
  hasUploadedLogo: boolean,
  pastedUrl: string | null | undefined,
): string | null {
  if (hasUploadedLogo) return `/api/organizations/${organizationId}/logo`;
  // An empty string is what an HTML form sends for a cleared text field, and
  // <img src=""> re-requests the current page — so it is treated as absent
  // rather than passed through.
  const trimmed = pastedUrl?.trim();
  return trimmed ? trimmed : null;
}

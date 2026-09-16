/**
 * Which roles belong to the client rather than to MSP staff.
 *
 * Used to decide whether to OFFER a control. It is a courtesy and nothing more:
 * every write goes through a route that declares the permission it needs, and
 * the row it touches is reachable only if RLS says so. Hiding a button stops a
 * pointless 403, it does not stop anything else — which is why the check is
 * this crude and why nothing security-relevant is allowed to depend on it.
 *
 * Deliberately not derived from the permission catalogue. A page that asked the
 * database "may this actor write?" and then rendered accordingly would be a
 * second authorisation path, drifting quietly out of step with the first.
 */
const CLIENT_ROLES = new Set(['client_admin', 'client_read_only']);

export function isClientRole(roleKey: string): boolean {
  return CLIENT_ROLES.has(roleKey);
}

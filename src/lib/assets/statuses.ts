/**
 * An asset's status: node_status in 0050, in the order the forms offer it.
 *
 * ONE LIST. Three forms and two routes each had their own copy, and the copies
 * said 'inactive' — which the enum has never held — and left out
 * 'decommissioned'. Choosing Inactive in the Edit dialog was a refusal from the
 * API. tests/integration/assets-sites.test.ts compares this with the enum.
 */
export const NODE_STATUSES = ['active', 'planned', 'maintenance', 'retired', 'decommissioned'] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];

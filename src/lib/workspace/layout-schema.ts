import { z } from 'zod';
import { LAYOUT_MAX, WIDGET_KEYS } from './widgets';

/**
 * A dashboard layout as a request body, shared by the personal route and the
 * team default route. Validated here for a message naming the bad key, and
 * again by helm.dashboard_layout_valid() so nothing else can store one.
 */
const keys = (what: string) =>
  z
    .array(z.enum(WIDGET_KEYS))
    .max(LAYOUT_MAX)
    .refine((list) => new Set(list).size === list.length, {
      message: `a widget cannot appear twice in ${what}`,
    });

export const layoutSchema = z.object({
  widgets: keys('widgets'),
  /** Optional so an older client that only sends `widgets` keeps working. */
  wide: keys('wide').optional(),
});

export type LayoutBody = z.infer<typeof layoutSchema>;

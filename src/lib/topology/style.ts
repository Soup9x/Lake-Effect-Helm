/**
 * How a diagram's lines and boxes may be drawn ((1190)).
 *
 * The CHECK constraints in (1190) are the authority; these lists mirror them so
 * the routes refuse a bad value with a 400 instead of a constraint error, and
 * the canvas offers exactly what the database will take.
 */
export const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export type LineStyle = (typeof LINE_STYLES)[number];

/** Relative to from → to, the order the line was drawn in. */
export const ARROWS = ['none', 'end', 'start', 'both'] as const;
export type Arrow = (typeof ARROWS)[number];

/**
 * Palette NAMES, not hex values: the canvas maps each to a colour that reads
 * in light and dark mode, and nobody's input becomes CSS in a reader's browser.
 */
export const DIAGRAM_COLORS = ['slate', 'blue', 'green', 'amber', 'red', 'purple'] as const;
export type DiagramColor = (typeof DIAGRAM_COLORS)[number];

/** The canvas size bounds, mirroring network_diagram_canvas_ck. */
export const CANVAS_LIMITS = { minW: 400, minH: 240, max: 10000 } as const;

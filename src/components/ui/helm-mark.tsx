import { cn } from '@/lib/ui/cn';

/**
 * The Helm mark.
 *
 * A compass rose over a ship's wheel — the two things the product is named for,
 * and the only artwork in the application. It is served as a file rather than
 * inlined so there is exactly one copy of the geometry: `public/helm-mark.svg`
 * is what components render and `src/app/icon.svg` is the same artwork as the
 * favicon, which Next.js requires to be a real file under `app/`.
 *
 * `<img>` rather than an inline `<svg>` on purpose. Inlining would put the same
 * 60 polygons into the HTML of every page, and the mark's colours are fixed by
 * design — they do not follow the theme — so there is nothing to gain from
 * having the DOM see the shapes.
 *
 * Decorative by default: the wordmark next to it already says "Helm", and a
 * screen reader announcing both reads the name twice. Pass a `label` where the
 * mark stands alone.
 */
export function HelmMark({
  className,
  label,
}: {
  className?: string;
  label?: string;
}) {
  return (
    // A plain <img>, not next/image: a fixed-size local SVG has nothing to
    // optimise, and Image() wraps its output in a span that this would have to
    // fight in the flex layouts it sits in.
    <img
      src="/helm-mark.svg"
      alt={label ?? ''}
      aria-hidden={label ? undefined : true}
      className={cn('select-none', className)}
      draggable={false}
    />
  );
}

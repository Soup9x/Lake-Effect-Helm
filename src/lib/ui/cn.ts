import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, with later Tailwind utilities winning over earlier ones.
 *
 * `clsx` alone would leave `px-2 px-4` in the output and let CSS source order
 * decide, which makes a variant prop silently not work depending on how the
 * stylesheet happened to be generated. `twMerge` resolves the conflict by
 * utility family instead.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

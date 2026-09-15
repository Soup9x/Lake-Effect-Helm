import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/ui/cn';

/**
 * `danger` is not a colour choice. It marks actions that are hard to undo or
 * that put credential material on screen, and it is used nowhere else — so the
 * colour keeps meaning something.
 */
const button = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm ' +
    'font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ' +
    '[&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-white hover:bg-brand-strong',
        secondary: 'bg-surface-raised text-ink border border-border-strong hover:bg-surface-sunken',
        ghost: 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
        danger: 'bg-danger text-white hover:brightness-90',
        link: 'text-brand underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-9 px-4',
        lg: 'h-10 px-5',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ComponentProps<'button'>,
    VariantProps<typeof button> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return <Component className={cn(button({ variant, size }), className)} {...props} />;
}

export { button as buttonVariants };

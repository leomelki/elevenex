import { cva, type VariantProps } from 'class-variance-authority';

export const progressBarVariants = cva(
  'relative w-full overflow-hidden rounded-full bg-muted',
  {
    variants: {
      zSize: {
        sm: 'h-1.5',
        default: 'h-2',
        lg: 'h-3',
      },
    },
    defaultVariants: {
      zSize: 'default',
    },
  },
);
export type ZardProgressBarVariants = VariantProps<typeof progressBarVariants>;

export const progressBarIndicatorVariants = cva(
  'h-full rounded-full transition-[width] duration-300 ease-out',
  {
    variants: {
      zType: {
        default: 'bg-primary',
        success: 'bg-success',
        destructive: 'bg-destructive',
      },
    },
    defaultVariants: {
      zType: 'default',
    },
  },
);
export type ZardProgressBarIndicatorVariants = VariantProps<
  typeof progressBarIndicatorVariants
>;

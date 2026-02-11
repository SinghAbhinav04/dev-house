'use client';

import clsx from 'clsx';

type BadgeVariant = 'success' | 'warning' | 'danger' | 'purple' | 'neutral';

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  success: 'bg-signal-ok/15 text-signal-ok',
  warning: 'bg-signal-warn/15 text-signal-warn',
  danger: 'bg-signal-bad/15 text-signal-bad',
  purple: 'bg-accent/15 text-accent',
  neutral: 'bg-surface-overlay text-ink-soft',
};

export function Badge({ children, variant = 'neutral', className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
        variantStyles[variant],
        className
      )}
    >
      {children}
    </span>
  );
}

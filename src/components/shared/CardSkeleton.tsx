'use client';

interface CardSkeletonProps {
  lines?: number;
  className?: string;
}

/**
 * Widths are a fixed cycle rather than random: a skeleton is rendered during
 * render, and Math.random() there produces a different layout on every
 * re-render, which reads as flicker rather than as loading.
 */
const LINE_WIDTHS = ['82%', '64%', '91%', '73%', '57%'];

export function CardSkeleton({ lines = 3, className }: CardSkeletonProps) {
  return (
    <div className={`rounded-xl border border-line bg-surface p-6 ${className}`}>
      <div className="animate-pulse space-y-3">
        <div className="h-3 w-24 rounded bg-surface-overlay" />
        <div className="h-8 w-40 rounded bg-surface-overlay" />
        {Array.from({ length: Math.max(0, lines - 1) }).map((_, i) => (
          <div key={i} className="h-3 rounded bg-surface-overlay" style={{ width: LINE_WIDTHS[i % LINE_WIDTHS.length] }} />
        ))}
      </div>
    </div>
  );
}

'use client';

import clsx from 'clsx';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
  padding?: boolean;
}

export function Card({ children, className, hover = false, padding = true }: CardProps) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-line bg-surface transition-colors',
        hover && 'hover:border-line-strong cursor-pointer',
        padding && 'p-6',
        className
      )}
    >
      {children}
    </div>
  );
}

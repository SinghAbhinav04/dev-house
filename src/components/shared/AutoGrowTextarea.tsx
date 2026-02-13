'use client';

import { useEffect, useRef, type TextareaHTMLAttributes } from 'react';

export function AutoGrowTextarea({
  value,
  className = '',
  maxRows = 6,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { maxRows?: number }) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = 'auto';
    const lineHeight = Number.parseFloat(window.getComputedStyle(el).lineHeight || '20');
    const maxHeight = lineHeight * maxRows + 4;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value, maxRows]);

  return (
    <textarea
      {...props}
      ref={textareaRef}
      value={value}
      rows={1}
      className={`${className} resize-none`}
    />
  );
}

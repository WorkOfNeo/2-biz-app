'use client';
import * as React from 'react';
import { cn } from '../../lib/cn';

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  // Note: bg-white is moved to the end so custom bg-* classes can override it
  // If className includes bg-*, the custom class will take precedence
  const hasCustomBg = className?.includes('bg-');
  return (
    <span 
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[11px]',
        !hasCustomBg && 'bg-white',
        className
      )} 
      {...props} 
    />
  );
}



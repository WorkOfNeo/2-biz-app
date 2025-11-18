'use client';
import * as React from 'react';
import { cn } from '../../lib/cn';

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] bg-white', className)} {...props} />;
}



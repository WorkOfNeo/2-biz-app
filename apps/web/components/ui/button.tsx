'use client';
import * as React from 'react';
import { cn } from '../../lib/cn';

type Variant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
type Size = 'sm' | 'md' | 'lg';

export function Button({
  className,
  variant = 'default',
  size = 'md',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  const base = 'inline-flex items-center justify-center rounded-md font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none';
  const variants: Record<Variant, string> = {
    default: 'bg-slate-900 text-white hover:bg-slate-800 focus:ring-slate-400',
    secondary: 'bg-slate-100 text-slate-900 hover:bg-slate-200 focus:ring-slate-300',
    outline: 'border border-slate-200 text-slate-900 hover:bg-slate-50 focus:ring-slate-300',
    ghost: 'text-slate-900 hover:bg-slate-50 focus:ring-slate-300',
    destructive: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-400',
  };
  const sizes: Record<Size, string> = {
    sm: 'h-8 px-2 py-1 text-xs',
    md: 'h-9 px-3 py-1.5 text-sm',
    lg: 'h-10 px-4 py-2 text-sm',
  };
  return <button className={cn(base, variants[variant], sizes[size], className)} {...props} />;
}



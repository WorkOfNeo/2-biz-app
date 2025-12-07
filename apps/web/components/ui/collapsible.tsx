'use client';
import * as React from 'react';
import { cn } from '../../lib/cn';
import { ChevronDown } from 'lucide-react';

interface CollapsibleProps {
  children: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

interface CollapsibleContextType {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const CollapsibleContext = React.createContext<CollapsibleContextType | null>(null);

export function Collapsible({ children, defaultOpen = false, className }: CollapsibleProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <CollapsibleContext.Provider value={{ open, setOpen }}>
      <div className={cn('w-full', className)}>{children}</div>
    </CollapsibleContext.Provider>
  );
}

export function CollapsibleTrigger({ 
  children, 
  className,
  asChild = false,
  isActive = false
}: { 
  children: React.ReactNode; 
  className?: string;
  asChild?: boolean;
  isActive?: boolean;
}) {
  const context = React.useContext(CollapsibleContext);
  if (!context) throw new Error('CollapsibleTrigger must be used within Collapsible');
  const { open, setOpen } = context;
  
  const content = (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        'hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 focus:ring-offset-slate-900',
        isActive 
          ? 'bg-slate-800 text-white border-l-2 border-white' 
          : 'text-slate-200',
        className
      )}
      aria-expanded={open}
      aria-controls="collapsible-content"
    >
      <ChevronDown 
        className={cn(
          'h-2.5 w-2.5 transition-transform duration-200 flex-shrink-0',
          open && 'rotate-180'
        )} 
      />
      <span className="flex items-center flex-1">{children}</span>
    </button>
  );
  
  return content;
}

export function CollapsibleContent({ 
  children, 
  className 
}: { 
  children: React.ReactNode; 
  className?: string;
}) {
  const context = React.useContext(CollapsibleContext);
  if (!context) throw new Error('CollapsibleContent must be used within Collapsible');
  const { open } = context;
  
  return (
    <div
      className={cn(
        'overflow-hidden transition-all duration-200 ease-in-out',
        open ? 'max-h-[1000px] opacity-100' : 'max-h-0 opacity-0',
        className
      )}
    >
      <div className="pt-1">{children}</div>
    </div>
  );
}


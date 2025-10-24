'use client';
import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { useRoles } from '../lib/supabaseClient';

function NavLink({ href, label }: { href: Route; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(href + '/');
  return (
    <Link
      href={href}
      className={
        'block rounded-md px-3 py-2 text-sm transition-colors ' +
        (active
          ? 'bg-slate-800 text-white'
          : 'text-slate-200 hover:bg-slate-800 hover:text-white')
      }
    >
      {label}
    </Link>
  );
}

export function SidebarNav() {
  const { has } = useRoles();
  return (
    <nav className="space-y-2">
      <NavLink href="/" label="Home" />
      <div>
        <div className="mt-4 mb-1 text-xs uppercase tracking-wider text-slate-400">Statistics</div>
        <div className="ml-2 space-y-1">
          <NavLink href="/statistics/general" label="General" />
          <NavLink href="/statistics/overview" label="Overview" />
          <NavLink href="/statistics/countries" label="Countries" />
          {has('admin') && <NavLink href="/statistics/countries/exports" label="Exports" />}
        </div>
      </div>
      <div>
        <div className="mt-4 mb-1 text-xs uppercase tracking-wider text-slate-400">Styles</div>
        <div className="ml-2 space-y-1">
          <NavLink href="/styles" label="Styles" />
          {(has('admin') || has('manager')) && <NavLink href="/styles/settings" label="Settings" />}
          <NavLink href="/styles/stock-list" label="Stock List" />
        </div>
      </div>
      <div>
        <div className="mt-4 mb-1 text-xs uppercase tracking-wider text-slate-400">Settings</div>
        <div className="ml-2 space-y-1">
          {has('admin') && <NavLink href="/settings/seasons" label="SEASONS" />}
          {has('admin') && <NavLink href="/settings/salespersons" label="SALESPERSONS" />}
          {(has('admin') || has('manager')) && <NavLink href="/settings/customers" label="CUSTOMERS" />}
          {has('admin') && <NavLink href="/settings/misc" label="MISC" />}
          {has('admin') && <NavLink href="/settings/runs" label="RUNS" />}
        </div>
      </div>
    </nav>
  );
}



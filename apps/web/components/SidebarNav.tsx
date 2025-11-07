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
          {!has('salesman') && has('admin') && <NavLink href="/statistics/dashboard" label="Dashboard" />}
          {!has('salesman') && <NavLink href="/statistics/general" label="General" />}
          {!has('salesman') && <NavLink href="/statistics/overview" label="Overview" />}
          {!has('salesman') && <NavLink href="/statistics/countries" label="Countries" />}
          {!has('salesman') && <NavLink href="/statistics/styles/top10" label="Top 10 Styles" />}
          {!has('salesman') && has('admin') && <NavLink href="/statistics/vendors/top10" label="Top 10 Vendors" />}
          {!has('salesman') && has('admin') && <NavLink href="/statistics/exports" label="Exports" />}
          {!has('salesman') && <NavLink href="/statistics/downloads" label="Downloads" />}
        </div>
      </div>
      <div>
        <div className="mt-4 mb-1 text-xs uppercase tracking-wider text-slate-400">Styles</div>
        <div className="ml-2 space-y-1">
          {!has('salesman') && <NavLink href="/styles" label="Styles" />}
          {!has('salesman') && has('admin') && <NavLink href="/styles/settings" label="Settings" />}
          <NavLink href="/styles/stock-list" label="Stock List" />
          {!has('salesman') && has('admin') && <NavLink href="/styles/statistics" label="Statistics" />}
          {!has('salesman') && has('admin') && <NavLink href="/styles/scraper" label="Stock Scraper" />}
          {!has('salesman') && has('admin') && <NavLink href="/styles/movements" label="Movements" />}
        </div>
      </div>
      <div>
        <div className="mt-4 mb-1 text-xs uppercase tracking-wider text-slate-400">Purchase</div>
        <div className="ml-2 space-y-1">
          {!has('salesman') && has('admin') && (
            <NavLink href="/purchase/orders" label="Purchase Orders" />
          )}
        </div>
      </div>
      <div>
        <div className="mt-4 mb-1 text-xs uppercase tracking-wider text-slate-400">Settings</div>
        <div className="ml-2 space-y-1">
          {!has('salesman') && has('admin') && <NavLink href="/settings/seasons" label="SEASONS" />}
          {!has('salesman') && has('admin') && <NavLink href="/settings/salespersons" label="SALESPERSONS" />}
          {!has('salesman') && has('admin') && <NavLink href="/settings/customers" label="CUSTOMERS" />}
          {!has('salesman') && has('admin') && <NavLink href="/settings/misc" label="MISC" />}
          {!has('salesman') && has('admin') && <NavLink href="/settings/jobs" label="JOBS" />}
          {!has('salesman') && has('admin') && <NavLink href="/settings/runs" label="RUNS" />}
        </div>
      </div>
      {(!has('salesman') && has('admin')) && (
        <div>
          <div className="mt-4 mb-1 text-xs uppercase tracking-wider text-slate-400">Admin</div>
          <div className="ml-2 space-y-1">
            <NavLink href="/admin" label="Dashboard" />
            <NavLink href="/admin/users" label="Users" />
            <NavLink href="/admin/roles" label="Roles" />
          </div>
        </div>
      )}
    </nav>
  );
}



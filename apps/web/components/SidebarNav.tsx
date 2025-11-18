'use client';
import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { useRoles } from '../lib/supabaseClient';
import { useState, useMemo } from 'react';

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
  const pathname = usePathname();
  const startsWith = (p: string) => pathname === p || pathname.startsWith(p + '/');
  const [open, setOpen] = useState(() => ({
    statistics: startsWith('/statistics'),
    styles: startsWith('/styles'),
    purchase: startsWith('/purchase'),
    sales: startsWith('/sales'),
    settings: startsWith('/settings'),
    admin: startsWith('/admin')
  }));
  function toggle(key: keyof typeof open) {
    setOpen((o) => ({ ...o, [key]: !o[key] }));
  }
  return (
    <nav className="space-y-2">
      <NavLink href="/" label="Home" />
      <div>
        <button onClick={() => toggle('statistics')} className="mt-4 mb-1 w-full text-left text-xs uppercase tracking-wider text-slate-400">
          Statistics
        </button>
        {open.statistics && (
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
        )}
      </div>
      <div>
        <button onClick={() => toggle('styles')} className="mt-4 mb-1 w-full text-left text-xs uppercase tracking-wider text-slate-400">
          Styles
        </button>
        {open.styles && (
        <div className="ml-2 space-y-1">
          {!has('salesman') && <NavLink href="/styles" label="Styles" />}
          {!has('salesman') && has('admin') && <NavLink href="/styles/settings" label="Settings" />}
          <NavLink href="/styles/stock-list" label="Stock List" />
          {!has('salesman') && has('admin') && <NavLink href="/styles/statistics" label="Statistics" />}
          {!has('salesman') && has('admin') && <NavLink href="/styles/scraper" label="Stock Scraper" />}
          {!has('salesman') && has('admin') && <NavLink href="/styles/movements" label="Movements" />}
        </div>
        )}
      </div>
      <div>
        <button onClick={() => toggle('purchase')} className="mt-4 mb-1 w-full text-left text-xs uppercase tracking-wider text-slate-400">
          Purchase
        </button>
        {open.purchase && (
        <div className="ml-2 space-y-1">
          {!has('salesman') && has('admin') && (
            <NavLink href="/purchase/orders" label="Purchase Orders" />
          )}
          {!has('salesman') && has('admin') && (
            <NavLink href="/purchase/make-order" label="Make order" />
          )}
        </div>
        )}
      </div>
      <div>
        <button onClick={() => toggle('sales')} className="mt-4 mb-1 w-full text-left text-xs uppercase tracking-wider text-slate-400">
          Sales
        </button>
        {open.sales && (
        <div className="ml-2 space-y-1">
          {!has('salesman') && has('admin') && <NavLink href="/sales/nielsens" label="Nielsens" />}
          {!has('salesman') && has('admin') && <NavLink href="/sales/make-purchase-order" label="Make Purchase Order" />}
        </div>
        )}
      </div>
      <div>
        <button onClick={() => toggle('settings')} className="mt-4 mb-1 w-full text-left text-xs uppercase tracking-wider text-slate-400">
          Settings
        </button>
        {open.settings && (
        <div className="ml-2 space-y-1">
          {!has('salesman') && has('admin') && <NavLink href="/settings/seasons" label="SEASONS" />}
          {!has('salesman') && has('admin') && <NavLink href="/settings/salespersons" label="SALESPERSONS" />}
          {!has('salesman') && has('admin') && <NavLink href="/settings/customers" label="CUSTOMERS" />}
          {!has('salesman') && has('admin') && <NavLink href="/settings/misc" label="MISC" />}
          {!has('salesman') && has('admin') && <NavLink href="/settings/jobs" label="JOBS" />}
          {!has('salesman') && has('admin') && <NavLink href="/settings/runs" label="RUNS" />}
        </div>
        )}
      </div>
      {(!has('salesman') && has('admin')) && (
        <div>
          <button onClick={() => toggle('admin')} className="mt-4 mb-1 w-full text-left text-xs uppercase tracking-wider text-slate-400">
            Admin
          </button>
          {open.admin && (
            <div className="ml-2 space-y-1">
              <NavLink href="/admin" label="Dashboard" />
              <NavLink href="/admin/users" label="Users" />
              <NavLink href="/admin/roles" label="Roles" />
            </div>
          )}
        </div>
      )}
    </nav>
  );
}



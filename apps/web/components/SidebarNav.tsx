'use client';
import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { useRoles, useRoleAccess } from '../lib/supabaseClient';
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
  const { can } = useRoleAccess();
  const React = require('react') as typeof import('react');
  const { createClientComponentClient } = require('@supabase/auth-helpers-nextjs');
  const supabase = createClientComponentClient();
  const [userName, setUserName] = React.useState<string>('');
  React.useEffect(() => {
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        setUserName(((user?.user_metadata as any)?.name as string) || (user?.email as string) || '');
      } catch {}
    })();
  }, []);
  const pathname = usePathname();
  const startsWith = (p: string) => pathname === p || pathname.startsWith(p + '/');
  const [open, setOpen] = useState(() => ({
    statistics: startsWith('/statistics'),
    styles: startsWith('/styles'),
    purchase: startsWith('/purchase'),
    sales: startsWith('/sales'),
    finance: startsWith('/finance'),
    settings: startsWith('/settings'),
    admin: startsWith('/admin')
  }));
  function toggle(key: keyof typeof open) {
    setOpen((o) => ({ ...o, [key]: !o[key] }));
  }
  // Build per-section link lists based on access
  const statLinks = [
    can('/statistics/dashboard') ? <NavLink key="sd" href="/statistics/dashboard" label="Dashboard" /> : null,
    can('/statistics/general') ? <NavLink key="sg" href="/statistics/general" label="General" /> : null,
    can('/statistics/overview') ? <NavLink key="so" href="/statistics/overview" label="Overview" /> : null,
    can('/statistics/countries') ? <NavLink key="sc" href="/statistics/countries" label="Countries" /> : null,
    can('/statistics/styles/top10') ? <NavLink key="st" href="/statistics/styles/top10" label="Top 15 Styles" /> : null,
    can('/statistics/vendors/top10') ? <NavLink key="sv" href="/statistics/vendors/top10" label="Top 10 Vendors" /> : null,
    can('/statistics/exports') ? <NavLink key="se" href="/statistics/exports" label="Exports" /> : null,
    can('/statistics/downloads') ? <NavLink key="sdw" href="/statistics/downloads" label="Downloads" /> : null,
  ].filter(Boolean) as any[];
  const financeLinks = [
    can('/finance/csv-skat') ? <NavLink key="fin-skat" href="/finance/csv-skat" label="CSV - Skat" /> : null,
  ].filter(Boolean) as any[];
  const stylesLinks = [
    can('/styles') ? <NavLink key="s" href="/styles" label="Styles" /> : null,
    can('/styles/settings') ? <NavLink key="ss" href="/styles/settings" label="Settings" /> : null,
    can('/styles/stock-list') ? <NavLink key="ssl" href="/styles/stock-list" label="Stock List" /> : null,
    can('/styles/statistics') ? <NavLink key="sst" href="/styles/statistics" label="Statistics" /> : null,
    can('/styles/scraper') ? <NavLink key="sscr" href="/styles/scraper" label="Stock Scraper" /> : null,
    can('/styles/movements') ? <NavLink key="sm" href="/styles/movements" label="Movements" /> : null,
  ].filter(Boolean) as any[];
  const purchaseLinks = [
    can('/purchase/orders') ? <NavLink key="po" href="/purchase/orders" label="Purchase Orders" /> : null,
    can('/purchase/make-order') ? <NavLink key="pmo" href="/purchase/make-order" label="Make order" /> : null,
    can('/purchase/app-pos') ? <NavLink key="pap" href="/purchase/app-pos" label="App PO's" /> : null,
  ].filter(Boolean) as any[];
  const salesLinks = [
    can('/sales/nielsens') ? <NavLink key="sn" href="/sales/nielsens" label="Nielsens" /> : null,
    can('/sales/make-purchase-order') ? <NavLink key="smpo" href="/sales/make-purchase-order" label="Make Purchase Order" /> : null,
  ].filter(Boolean) as any[];
  const settingsLinks = [
    can('/settings/seasons') ? <NavLink key="set-seasons" href="/settings/seasons" label="SEASONS" /> : null,
    can('/settings/salespersons') ? <NavLink key="set-sp" href="/settings/salespersons" label="SALESPERSONS" /> : null,
    can('/settings/customers') ? <NavLink key="set-cust" href="/settings/customers" label="CUSTOMERS" /> : null,
    can('/settings/historical-sales') ? <NavLink key="set-hist" href="/settings/historical-sales" label="HISTORICAL SALES" /> : null,
    can('/settings/misc') ? <NavLink key="set-misc" href="/settings/misc" label="MISC" /> : null,
    can('/settings/jobs') ? <NavLink key="set-jobs" href="/settings/jobs" label="JOBS" /> : null,
    can('/settings/runs') ? <NavLink key="set-runs" href="/settings/runs" label="RUNS" /> : null,
  ].filter(Boolean) as any[];
  const adminLinks = [
    can('/admin') ? <NavLink key="ad" href="/admin" label="Dashboard" /> : null,
    can('/admin/users') ? <NavLink key="ad-users" href="/admin/users" label="Users" /> : null,
    can('/admin/roles') ? <NavLink key="ad-roles" href="/admin/roles" label="Roles" /> : null,
  ].filter(Boolean) as any[];
  return (
    <nav className="space-y-2">
      {userName && <div className="px-3 py-2 text-xs text-slate-300">Signed in as<br/><span className="text-white font-medium">{userName}</span></div>}
      <NavLink href="/" label="Home" />
      {statLinks.length > 0 && <div>
        <button onClick={() => toggle('statistics')} className="mt-4 mb-1 w-full text-left text-xs uppercase tracking-wider text-slate-400">
          Statistics
        </button>
        {open.statistics && statLinks.length > 0 && (<div className="ml-2 space-y-1">{statLinks}</div>)}
      </div>}
      {financeLinks.length > 0 && <div>
        <button onClick={() => toggle('finance')} className="mt-4 mb-1 w-full text-left text-xs uppercase tracking-wider text-slate-400">
          Finance
        </button>
        {open.finance && financeLinks.length > 0 && (<div className="ml-2 space-y-1">{financeLinks}</div>)}
      </div>}
      {stylesLinks.length > 0 && <div>
        <button onClick={() => toggle('styles')} className="mt-4 mb-1 w-full text-left text-xs uppercase tracking-wider text-slate-400">
          Styles
        </button>
        {open.styles && stylesLinks.length > 0 && (<div className="ml-2 space-y-1">{stylesLinks}</div>)}
      </div>}
      {purchaseLinks.length > 0 && <div>
        <button onClick={() => toggle('purchase')} className="mt-4 mb-1 w-full text-left text-xs uppercase tracking-wider text-slate-400">
          Purchase
        </button>
        {open.purchase && purchaseLinks.length > 0 && (<div className="ml-2 space-y-1">{purchaseLinks}</div>)}
      </div>}
      {salesLinks.length > 0 && <div>
        <button onClick={() => toggle('sales')} className="mt-4 mb-1 w-full text-left text-xs uppercase tracking-wider text-slate-400">
          Sales
        </button>
        {open.sales && salesLinks.length > 0 && (<div className="ml-2 space-y-1">{salesLinks}</div>)}
      </div>}
      {settingsLinks.length > 0 && <div>
        <button onClick={() => toggle('settings')} className="mt-4 mb-1 w-full text-left text-xs uppercase tracking-wider text-slate-400">
          Settings
        </button>
        {open.settings && settingsLinks.length > 0 && (<div className="ml-2 space-y-1">{settingsLinks}</div>)}
      </div>}
      {(has('admin')) && (
        <div>
          <button onClick={() => toggle('admin')} className="mt-4 mb-1 w-full text-left text-xs uppercase tracking-wider text-slate-400">
            Admin
          </button>
          {open.admin && adminLinks.length > 0 && (
            <div className="ml-2 space-y-1">
              {adminLinks}
            </div>
          )}
        </div>
      )}
      <div className="mt-6 px-3">
        <SignOutButton />
      </div>
    </nav>
  );
}

function SignOutButton() {
  const React = require('react') as typeof import('react');
  const { createClientComponentClient } = require('@supabase/auth-helpers-nextjs');
  const supabase = createClientComponentClient();
  const [busy, setBusy] = React.useState(false);
  return (
    <button
      className={"w-full text-left text-sm rounded-md border px-3 py-2 " + (busy ? 'opacity-70' : 'hover:bg-slate-800 text-slate-200')}
      onClick={async () => {
        try {
          setBusy(true);
          await supabase.auth.signOut();
          window.location.href = '/signin';
        } finally {
          setBusy(false);
        }
      }}
    >
      Sign out
    </button>
  );
}



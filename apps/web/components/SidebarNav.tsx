'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRoles, useRoleAccess } from '../lib/supabaseClient';
import { Button } from './ui/button';
import { cn } from '../lib/cn';
import { ChevronDown, ChevronRight } from 'lucide-react';

// With Next.js `experimental.typedRoutes`, the `Route` type is a strict union.
// Some valid routes can still fail typing during build; keep `href` as a string and cast at the Link boundary.
function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(href + '/');
  return (
    <Link
      href={href as any}
      className={cn(
        'flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-white/10 text-white ring-1 ring-white/10 shadow-sm'
          : 'text-slate-200/90 hover:bg-white/5 hover:text-white'
      )}
    >
      <span>{label}</span>
    </Link>
  );
}

function CollapsibleSection({ 
  title, 
  links, 
  sectionKey, 
  isOpen, 
  onToggle 
}: { 
  title: string; 
  links: any[]; 
  sectionKey: string; 
  isOpen: boolean; 
  onToggle: () => void;
}) {
  if (links.length === 0) return null;
  
  return (
    <div className="mt-4">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between text-xs uppercase tracking-wider px-3 py-2 hover:bg-white/5 rounded-lg transition-colors text-slate-200/80"
      >
        <span>{title}</span>
        {isOpen ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
      </button>
      {isOpen && (
        <div className="ml-2 space-y-1 mt-1">{links}</div>
      )}
    </div>
  );
}

export function SidebarNav() {
  const { has } = useRoles();
  const { can } = useRoleAccess();
  const pathname = usePathname();
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
  
  // Determine which section contains the active page
  const getActiveSection = React.useMemo(() => {
    if (pathname.startsWith('/statistics/') && pathname !== '/statistics/dashboard') return 'statistics';
    if (pathname.startsWith('/finance/')) return 'finance';
    if (pathname.startsWith('/styles/')) return 'styles';
    if (pathname.startsWith('/purchase/') || pathname.startsWith('/ai-analysis')) return 'purchase';
    if (pathname.startsWith('/sales/')) return 'sales';
    if (pathname.startsWith('/settings/') || pathname === '/statistics/exports' || pathname === '/statistics/downloads') return 'settings';
    if (pathname.startsWith('/admin/')) return 'admin';
    return null;
  }, [pathname]);
  
  // Track which sections are open (only active section open by default)
  const [openSections, setOpenSections] = React.useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (getActiveSection) {
      initial.add(getActiveSection);
    }
    return initial;
  });
  
  // Update open sections when pathname changes (expand active section)
  React.useEffect(() => {
    if (getActiveSection) {
      setOpenSections(prev => {
        const next = new Set(prev);
        next.add(getActiveSection!);
        return next;
      });
    }
  }, [getActiveSection]);
  
  const toggleSection = (sectionKey: string) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      if (next.has(sectionKey)) {
        next.delete(sectionKey);
      } else {
        next.add(sectionKey);
      }
      return next;
    });
  };
  // Build per-section link lists based on access
  // Dashboard moved out of Statistics
  const dashboardLink = can('/statistics/dashboard') ? <NavLink key="dashboard" href="/statistics/dashboard" label="Dashboard" /> : null;
  const statLinks = [
    can('/statistics/general') ? <NavLink key="sg" href="/statistics/general" label="Sælgere" /> : null,
    can('/statistics/overview') ? <NavLink key="so" href="/statistics/overview" label="Overblik" /> : null,
    can('/statistics/countries') ? <NavLink key="sc" href="/statistics/countries" label="Lande" /> : null,
    can('/statistics/suppleringer') ? <NavLink key="ssu" href="/statistics/suppleringer" label="Suppleringer" /> : null,
    can('/statistics/styles/top10') ? <NavLink key="st" href="/statistics/styles/top10" label="Top 15 Styles" /> : null,
    can('/statistics/vendors/top10') ? <NavLink key="sv" href="/statistics/vendors/top10" label="Top 10 leverandører" /> : null,
    can('/statistics/downloads') ? <NavLink key="sdw" href="/statistics/downloads" label="Downloads" /> : null,
  ].filter(Boolean) as any[];
  const financeLinks = [
    can('/finance/csv-skat') ? <NavLink key="fin-skat" href="/finance/csv-skat" label="CSV - Skat" /> : null,
    can('/finance/customs') ? <NavLink key="fin-customs" href="/finance/customs" label="CUSTOMS" /> : null,
    can('/finance/correction') ? <NavLink key="fin-correction" href="/finance/correction" label="CORRECTION" /> : null,
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
    can('/purchase/dashboard') ? <NavLink key="pd" href="/purchase/dashboard" label="Dashboard" /> : null,
    <NavLink key="pai" href="/ai-analysis" label="AI Analysis" />, // Always visible - purchase round suggestions
    can('/purchase/orders') ? <NavLink key="po" href="/purchase/orders" label="Purchase Orders" /> : null,
    can('/purchase/call-off') ? <NavLink key="pcalloff" href="/purchase/call-off" label="NOOS Call-Off" /> : null,
    can('/purchase/call-off-learning') ? <NavLink key="pcallofflearn" href="/purchase/call-off-learning" label="Call-Off Learning" /> : null,
    can('/purchase/noos') ? <NavLink key="pnoos" href="/purchase/noos" label="NOOS Checker" /> : null,
    can('/purchase/smart-draft') ? <NavLink key="psd" href="/purchase/smart-draft" label="Smart Draft" /> : null,
    can('/purchase/conversations') ? <NavLink key="pconv" href="/purchase/conversations" label="Conversations" /> : null,
    can('/purchase/suppliers') ? <NavLink key="psup" href="/purchase/suppliers" label="Suppliers" /> : null,
    can('/purchase/feedback') ? <NavLink key="pfb" href="/purchase/feedback" label="AI Feedback" /> : null,
    can('/purchase/packinglists-pdf') ? <NavLink key="ppdf" href="/purchase/packinglists-pdf" label="Packinglists (PDF)" /> : null,
  ].filter(Boolean) as any[];
  const salesLinks = [
    can('/sales/nielsens') ? <NavLink key="sn" href="/sales/nielsens" label="Nielsens" /> : null,
    can('/sales/make-purchase-order') ? <NavLink key="smpo" href="/sales/make-purchase-order" label="Make Purchase Order" /> : null,
    can('/sales/sales-orders') ? <NavLink key="sso" href="/sales/sales-orders" label="Sales Orders" /> : null,
  ].filter(Boolean) as any[];
  // PDF'er and Exports moved to Settings
  const settingsLinks = [
    can('/settings/seasons') ? <NavLink key="set-seasons" href="/settings/seasons" label="SEASONS" /> : null,
    can('/settings/salespersons') ? <NavLink key="set-sp" href="/settings/salespersons" label="SALESPERSONS" /> : null,
    can('/settings/customers') ? <NavLink key="set-cust" href="/settings/customers" label="CUSTOMERS" /> : null,
    can('/settings/historical-sales') ? <NavLink key="set-hist" href="/settings/historical-sales" label="HISTORICAL SALES" /> : null,
    can('/settings/integrations') ? <NavLink key="set-int" href="/settings/integrations" label="INTEGRATIONS" /> : null,
    can('/settings/misc') ? <NavLink key="set-misc" href="/settings/misc" label="MISC" /> : null,
    can('/settings/jobs') ? <NavLink key="set-jobs" href="/settings/jobs" label="JOBS" /> : null,
    can('/settings/runs') ? <NavLink key="set-runs" href="/settings/runs" label="RUNS" /> : null,
    can('/statistics/exports') ? <NavLink key="set-exports" href="/statistics/exports" label="PDF'er" /> : null,
    can('/statistics/downloads') ? <NavLink key="set-downloads" href="/statistics/downloads" label="Exports" /> : null,
  ].filter(Boolean) as any[];
  const adminLinks = [
    can('/admin') ? <NavLink key="ad" href="/admin" label="Dashboard" /> : null,
    can('/admin/users') ? <NavLink key="ad-users" href="/admin/users" label="Users" /> : null,
    can('/admin/roles') ? <NavLink key="ad-roles" href="/admin/roles" label="Roles" /> : null,
  ].filter(Boolean) as any[];
  return (
    <nav className="space-y-2">
      {userName && (
        <div className="px-3 py-2 text-xs text-slate-300/90">
          Signed in as<br/>
          <span className="text-white font-medium">{userName}</span>
        </div>
      )}
      <NavLink href="/" label="Home" />
      {dashboardLink}
      <CollapsibleSection
        title="Statistics"
        links={statLinks}
        sectionKey="statistics"
        isOpen={openSections.has('statistics')}
        onToggle={() => toggleSection('statistics')}
      />
      <CollapsibleSection
        title="Finance"
        links={financeLinks}
        sectionKey="finance"
        isOpen={openSections.has('finance')}
        onToggle={() => toggleSection('finance')}
      />
      <CollapsibleSection
        title="Styles"
        links={stylesLinks}
        sectionKey="styles"
        isOpen={openSections.has('styles')}
        onToggle={() => toggleSection('styles')}
      />
      <CollapsibleSection
        title="Purchase"
        links={purchaseLinks}
        sectionKey="purchase"
        isOpen={openSections.has('purchase')}
        onToggle={() => toggleSection('purchase')}
      />
      <CollapsibleSection
        title="Sales"
        links={salesLinks}
        sectionKey="sales"
        isOpen={openSections.has('sales')}
        onToggle={() => toggleSection('sales')}
      />
      <CollapsibleSection
        title="Settings"
        links={settingsLinks}
        sectionKey="settings"
        isOpen={openSections.has('settings')}
        onToggle={() => toggleSection('settings')}
      />
      {has('admin') && (
        <CollapsibleSection
          title="Admin"
          links={adminLinks}
          sectionKey="admin"
          isOpen={openSections.has('admin')}
          onToggle={() => toggleSection('admin')}
        />
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
    <Button
      variant="outline"
      className="w-full justify-start text-slate-200 border-slate-700 hover:bg-slate-800 hover:text-white"
      disabled={busy}
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
    </Button>
  );
}

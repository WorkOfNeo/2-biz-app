'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useRoles, useRoleAccess, type UserRole } from '../lib/supabaseClient';
import { Button } from './ui/button';
import { cn } from '../lib/cn';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import React, { useState, useEffect, useMemo } from 'react';

// Link definition types
type LinkDef = { href: string; label: string; alwaysVisible?: boolean };
type GroupDef = { title: string; groupKey: string; links: LinkDef[] };
type SectionItem = LinkDef | GroupDef;

function isGroup(item: SectionItem): item is GroupDef {
  return 'groupKey' in item;
}

// Section configuration
type SectionConfig = {
  key: string;
  title: string;
  items: SectionItem[];
  requiresRole?: UserRole;
};

const SECTIONS: SectionConfig[] = [
  {
    key: 'statistics',
    title: 'Statistics',
    items: [
      { href: '/statistics/general', label: 'Sælgere' },
      { href: '/statistics/overview', label: 'Overblik' },
      { href: '/statistics/countries', label: 'Lande' },
      { href: '/statistics/suppleringer', label: 'Suppleringer' },
      { href: '/statistics/styles/top10', label: 'Top 15 Styles' },
      { href: '/statistics/vendors/top10', label: 'Top 10 leverandører' },
      { href: '/statistics/downloads', label: 'Downloads' },
    ],
  },
  {
    key: 'finance',
    title: 'Finance',
    items: [
      { href: '/finance/csv-skat', label: 'CSV - Skat' },
      {
        title: 'Customs',
        groupKey: 'finance-customs',
        links: [
          { href: '/finance/customs', label: 'CUSTOMS PERIOD' },
          { href: '/finance/correction', label: 'CORRECTION' },
        ],
      },
    ],
  },
  {
    key: 'styles',
    title: 'Styles',
    items: [
      { href: '/styles', label: 'Styles' },
      { href: '/styles/settings', label: 'Settings' },
      { href: '/styles/stock-list', label: 'Stock List' },
      { href: '/styles/statistics', label: 'Statistics' },
      { href: '/styles/scraper', label: 'Stock Scraper' },
      { href: '/styles/movements', label: 'Movements' },
    ],
  },
  {
    key: 'purchase',
    title: 'Purchase',
    items: [
      { href: '/purchase/dashboard', label: 'Dashboard' },
      { href: '/ai-analysis', label: 'AI Analysis', alwaysVisible: true },
      { href: '/purchase/orders', label: 'Purchase Orders' },
      { href: '/purchase/size-calculator', label: 'NOOS Call Off' },
      { href: '/purchase/call-off-learning', label: 'Learning Studio' },
      { href: '/purchase/noos', label: 'NOOS Checker' },
      { href: '/purchase/smart-draft', label: 'Smart Draft' },
      { href: '/purchase/conversations', label: 'Conversations' },
      { href: '/purchase/suppliers', label: 'Suppliers' },
      { href: '/purchase/feedback', label: 'AI Feedback' },
      { href: '/purchase/packinglists-pdf', label: 'Packinglists (PDF)' },
    ],
  },
  {
    key: 'sales',
    title: 'Sales',
    items: [
      { href: '/sales/nielsens', label: 'Nielsens' },
      { href: '/sales/make-purchase-order', label: 'Make Purchase Order' },
      { href: '/sales/sales-orders', label: 'Sales Orders' },
      { href: '/sales/historical-sales', label: 'Historical Sales', alwaysVisible: true },
    ],
  },
  {
    key: 'settings',
    title: 'Settings',
    items: [
      { href: '/settings/seasons', label: 'SEASONS' },
      { href: '/settings/salespersons', label: 'SALESPERSONS' },
      { href: '/settings/customers', label: 'CUSTOMERS' },
      { href: '/settings/integrations', label: 'INTEGRATIONS' },
      { href: '/settings/misc', label: 'MISC' },
      { href: '/settings/jobs', label: 'JOBS' },
      { href: '/settings/runs', label: 'RUNS' },
      { href: '/statistics/exports', label: "PDF'er" },
      { href: '/statistics/downloads', label: 'Exports' },
    ],
  },
  {
    key: 'admin',
    title: 'Admin',
    items: [
      { href: '/admin', label: 'Dashboard' },
      { href: '/admin/users', label: 'Users' },
      { href: '/admin/roles', label: 'Roles' },
    ],
    requiresRole: 'admin',
  },
];

// NavLink component
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

// Collapsible group for nested links (e.g., Finance > Customs)
function CollapsibleNavGroup({
  title,
  links,
  isOpen,
  onToggle,
  active,
}: {
  title: string;
  links: React.ReactNode[];
  isOpen: boolean;
  onToggle: () => void;
  active: boolean;
}) {
  if (links.length === 0) return null;

  return (
    <div className="space-y-1">
      <button
        onClick={onToggle}
        className={cn(
          'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors',
          active
            ? 'bg-white/10 text-white ring-1 ring-white/10 shadow-sm'
            : 'text-slate-200/90 hover:bg-white/5 hover:text-white'
        )}
      >
        <span>{title}</span>
        {isOpen ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
      </button>
      {isOpen && <div className="ml-3 space-y-1">{links}</div>}
    </div>
  );
}

// Section button in main panel
function SectionButton({
  title,
  onClick,
  hasLinks,
}: {
  title: string;
  onClick: () => void;
  hasLinks: boolean;
}) {
  if (!hasLinks) return null;

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between text-xs uppercase tracking-wider px-3 py-2 hover:bg-white/5 rounded-lg transition-colors text-slate-200/80 mt-4"
    >
      <span>{title}</span>
      <ChevronRight className="h-4 w-4" />
    </button>
  );
}

// Back header in section panel
function BackHeader({
  title,
  onClick,
}: {
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 text-xs uppercase tracking-wider px-3 py-2 hover:bg-white/5 rounded-lg transition-colors text-slate-200/80 mb-2"
    >
      <ChevronLeft className="h-4 w-4" />
      <span>{title}</span>
    </button>
  );
}

export function SidebarNav() {
  const { has } = useRoles();
  const { can } = useRoleAccess();
  const pathname = usePathname();
  const router = useRouter();
  const { createClientComponentClient } = require('@supabase/auth-helpers-nextjs');
  const supabase = createClientComponentClient();
  const [userName, setUserName] = useState<string>('');

  useEffect(() => {
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        setUserName(((user?.user_metadata as any)?.name as string) || (user?.email as string) || '');
      } catch {}
    })();
  }, [supabase.auth]);

  // Determine which section contains the active page
  const getActiveSection = useMemo(() => {
    if (pathname.startsWith('/statistics/') && pathname !== '/statistics/dashboard') return 'statistics';
    if (pathname.startsWith('/finance/')) return 'finance';
    if (pathname.startsWith('/styles/')) return 'styles';
    if (pathname.startsWith('/purchase/') || pathname.startsWith('/ai-analysis')) return 'purchase';
    if (pathname.startsWith('/sales/')) return 'sales';
    if (pathname.startsWith('/settings/') || pathname === '/statistics/exports' || pathname === '/statistics/downloads') return 'settings';
    if (pathname.startsWith('/admin/')) return 'admin';
    return null;
  }, [pathname]);

  // Active panel state: 'main' or a section key
  const [activePanel, setActivePanel] = useState<string>(() => getActiveSection || 'main');

  // Sync panel with pathname on navigation (e.g., direct link, browser back)
  useEffect(() => {
    setActivePanel(getActiveSection || 'main');
  }, [getActiveSection]);

  // Track open groups within sections (e.g., Finance > Customs)
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (pathname.startsWith('/finance/customs') || pathname.startsWith('/finance/correction')) {
      initial.add('finance-customs');
    }
    return initial;
  });

  useEffect(() => {
    if (pathname.startsWith('/finance/customs') || pathname.startsWith('/finance/correction')) {
      setOpenGroups(prev => {
        const next = new Set(prev);
        next.add('finance-customs');
        return next;
      });
    }
  }, [pathname]);

  const toggleGroup = (groupKey: string) => {
    setOpenGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };

  // Helper: get all accessible links for a section (flattened)
  const getAccessibleLinks = (section: SectionConfig): LinkDef[] => {
    const links: LinkDef[] = [];
    for (const item of section.items) {
      if (isGroup(item)) {
        for (const link of item.links) {
          if (link.alwaysVisible || can(link.href)) {
            links.push(link);
          }
        }
      } else {
        if (item.alwaysVisible || can(item.href)) {
          links.push(item);
        }
      }
    }
    return links;
  };

  // Get first accessible href for a section
  const getFirstHref = (section: SectionConfig): string | null => {
    const links = getAccessibleLinks(section);
    return links[0]?.href ?? null;
  };

  // Build link elements for a section
  const buildSectionLinks = (section: SectionConfig): React.ReactNode[] => {
    const elements: React.ReactNode[] = [];
    for (const item of section.items) {
      if (isGroup(item)) {
        const groupLinks = item.links
          .filter(link => link.alwaysVisible || can(link.href))
          .map(link => <NavLink key={link.href} href={link.href} label={link.label} />);
        if (groupLinks.length > 0) {
          elements.push(
            <CollapsibleNavGroup
              key={item.groupKey}
              title={item.title}
              links={groupLinks}
              active={item.links.some(l => pathname.startsWith(l.href))}
              isOpen={openGroups.has(item.groupKey)}
              onToggle={() => toggleGroup(item.groupKey)}
            />
          );
        }
      } else {
        if (item.alwaysVisible || can(item.href)) {
          elements.push(<NavLink key={item.href} href={item.href} label={item.label} />);
        }
      }
    }
    return elements;
  };

  // Handle section click: switch panel and navigate to first link
  const handleSectionClick = (section: SectionConfig) => {
    const firstHref = getFirstHref(section);
    if (firstHref) {
      setActivePanel(section.key);
      router.push(firstHref as any);
    }
  };

  // Handle back click: return to main panel
  const handleBackClick = () => {
    setActivePanel('main');
  };

  // Filter sections by role requirement and check if they have accessible links
  const visibleSections = SECTIONS.filter(section => {
    if (section.requiresRole && !has(section.requiresRole)) return false;
    return getAccessibleLinks(section).length > 0;
  });

  // Get current section for the section panel
  const currentSection = SECTIONS.find(s => s.key === activePanel);

  // Dashboard link (outside of sections)
  const dashboardLink = can('/statistics/dashboard') ? (
    <NavLink key="dashboard" href="/statistics/dashboard" label="Dashboard" />
  ) : null;

  return (
    <nav className="overflow-hidden">
      <div
        className="flex transition-transform duration-200 ease-out"
        style={{
          transform: activePanel === 'main' ? 'translateX(0)' : 'translateX(-50%)',
          width: '200%',
        }}
      >
        {/* Main Panel */}
        <div className="w-1/2 flex-shrink-0 space-y-2">
          {userName && (
            <div className="px-3 py-2 text-xs text-slate-300/90">
              Signed in as<br />
              <span className="text-white font-medium">{userName}</span>
            </div>
          )}
          <NavLink href="/" label="Home" />
          {dashboardLink}
          {visibleSections.map(section => (
            <SectionButton
              key={section.key}
              title={section.title}
              onClick={() => handleSectionClick(section)}
              hasLinks={getAccessibleLinks(section).length > 0}
            />
          ))}
          <div className="mt-6 px-3">
            <SignOutButton />
          </div>
        </div>

        {/* Section Panel */}
        <div className="w-1/2 flex-shrink-0 space-y-1">
          {currentSection && (
            <>
              <BackHeader title={currentSection.title} onClick={handleBackClick} />
              <div className="space-y-1">
                {buildSectionLinks(currentSection)}
              </div>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}

function SignOutButton() {
  const { createClientComponentClient } = require('@supabase/auth-helpers-nextjs');
  const supabase = createClientComponentClient();
  const [busy, setBusy] = useState(false);
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

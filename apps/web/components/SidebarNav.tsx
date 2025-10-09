'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(href + '/');
  return (
    <Link
      href={href}
      className={
        'block px-3 py-2 rounded-md hover:bg-slate-800 ' +
        (active ? 'bg-slate-800 text-white' : 'text-slate-200')
      }
    >
      {label}
    </Link>
  );
}

export function SidebarNav() {
  return (
    <nav className="space-y-2">
      <NavLink href="/" label="Home" />
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-400 mt-4 mb-1">Statistics</div>
        <div className="space-y-1 ml-2">
          <NavLink href="/admin" label="General" />
          <NavLink href="/statistics/overview" label="Overview" />
          <NavLink href="/statistics/countries" label="Countries" />
        </div>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-400 mt-4 mb-1">Settings</div>
        <div className="space-y-1 ml-2">
          <NavLink href="/settings/seasons" label="SEASONS" />
          <NavLink href="/settings/salespersons" label="SALESPERSONS" />
          <NavLink href="/settings/customers" label="CUSTOMERS" />
          <NavLink href="/settings/misc" label="MISC" />
          <NavLink href="/settings/runs" label="RUNS" />
        </div>
      </div>
    </nav>
  );
}



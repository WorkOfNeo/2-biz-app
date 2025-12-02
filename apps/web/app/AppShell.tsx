"use client";
import { usePathname } from 'next/navigation';
import { SidebarNav } from '../components/SidebarNav';
import { useRoles } from '../lib/supabaseClient';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuth = pathname === '/signin';
  const { has } = useRoles();
  const hideSidebar = isAuth || has('sales');
  if (hideSidebar) {
    return <main className="min-h-screen">{children}</main>;
  }
  return (
    <div className="flex min-h-screen">
      <aside className="sidebar w-64 p-4 flex-shrink-0">
        <SidebarNav />
      </aside>
      <main className="flex-1 min-w-0 p-6 overflow-x-hidden">{children}</main>
    </div>
  );
}



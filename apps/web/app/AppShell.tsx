"use client";
import { usePathname } from 'next/navigation';
import { SidebarNav } from '../components/SidebarNav';
import { useRoles } from '../lib/supabaseClient';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuth = pathname === '/signin';
  const { has } = useRoles();
  const hideSidebar = isAuth || has('salesman');
  if (hideSidebar) {
    return <main className="min-h-screen">{children}</main>;
  }
  return (
    <div className="flex min-h-screen">
      <aside className="sidebar w-64 p-4">
        <SidebarNav />
      </aside>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}



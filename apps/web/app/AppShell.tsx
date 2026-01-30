"use client";
import { usePathname } from 'next/navigation';
import { SidebarNav } from '../components/SidebarNav';
import { useRoles } from '../lib/supabaseClient';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuth = pathname === '/signin';
  const { has } = useRoles();
  // All authenticated users can see the sidebar (including sales users for Chat access)
  const hideSidebar = isAuth;
  
  if (hideSidebar) {
    return <main className="min-h-screen">{children}</main>;
  }
  return (
    <div className="flex min-h-screen relative">
      <aside className="sidebar flex-shrink-0 w-72 p-4 overflow-hidden">
        <SidebarNav />
      </aside>
      <main className="flex-1 min-w-0 relative">
        <div className="p-6 overflow-x-hidden">
          {children}
        </div>
      </main>
    </div>
  );
}


